// Chrome extension listeners
/**
 * Reset the extension once updated
 */
chrome.runtime.onInstalled.addListener(async (details) => {
    console.log(details.reason);
    await reset();

    await chrome.storage.local.remove("song_name");

    // Check if there is anything left
    console.log(await chrome.storage.local.get(null));
});

/**
 * Main extension functionality, detecting the kink stream and planning the scraper
 */
chrome.tabs.onUpdated.addListener( async (id, update, tab) => {
    // Check if the tab is a kink stream
    if (tab.url && stream_urls.includes(tab.url)) {

        // Check if the tab is loaded and playing
        if(tab.status == "complete" && tab.audible) {
            // Save the window ID
            console.log("Listening to a Kink stream in window", tab.id);
            await chrome.storage.local.set({"windowId": tab.id});

            // Set the acraper to run on 1 minute intervals, and run it directly
            chrome.alarms.create("KinkScrobbler", {periodInMinutes: 1});
            await start_scraper();
        }
        else{
            // The user is not listening (anymore?) to the Kink stream, so cancel any running scrapers.
            console.log("Stopped listening?");
            await reset();
            // TODO: Detect a stopped stream
        }
    }
});

/**
 * Makes clicking the extension icon open the Kink stream
 */
chrome.action.onClicked.addListener((curTab) => {
    chrome.tabs.create({"url": stream_urls[0]});
});


// Extension functionality
/**
 * Resets the extension by removing listeners and emptying runtime storage
 */
async function reset(){
    console.log("Resetting alarms and storage");
    let alarm = chrome.alarms.clear("KinkScrobbler");
    let storage = chrome.storage.local.remove(["windowId", "prev_scraped_string", "song_string", "song_artist", "song_track", "song_start", "song_scrobbled"]);
    await Promise.all([alarm, storage]);
}

/**
 * Entry point of this extensions main loop
 * Injects the content_script on the tab which plays the stream to scrape the current song
 * @param alarm (optional) Set if the method is called by an alarm. The alarm identifier is alarm.name
 */
chrome.alarms.onAlarm.addListener(start_scraper);
async function start_scraper(alarm) {
    if(alarm && alarm.name != "KinkScrobbler") {
        console.log("Wrong alarm");
        return;
    }
    // Get the windowID of the tab which plays the stream
    windowId = (await chrome.storage.local.get("windowId")).windowId;

    // Use the message system as a "callback" function
    chrome.runtime.onMessage.addListener(handle_scraper);
    // Execute content
    chrome.scripting.executeScript({
       target: {tabId: windowId},
       files: ['resources/js/jquery-3.6.0.min.js', 'content_script.js']
    });
}

/**
 * Part of this extensions main loop, will be triggered by the message sent from the content_script on the stream page.
 * Will process the scraped information, and make the corresponding LastFM calls.
 * @param request Contains the message which triggered the method
 * @param sender Contains information about the sender
 * @param sendResponse
 */
async function handle_scraper(request, sender, sendResponse) {
    // Check if this is a message from the scraper
    if(sender.url != "https://kink.nl/player?stream=stream.kink") {
        console.log("handle_scraper: wrong sender");
        console.log(sender);
        return
    }
    // Callback happened, remove myself as listener
    chrome.runtime.onMessage.removeListener(handle_scraper);

    // Check the scraped text and compare it to the last scraped text
    let cur_string = request.result;
    let prev_string = (await chrome.storage.local.get("prev_scraped_string")).prev_scraped_string;
    if(prev_string != cur_string){
        // Scraped text differs from previous text
        console.log("Scraped new text:", cur_string);

        // Check if previous text was a non default text, if so, scrobble the song and remove details from storage
        if(!default_texts.includes(prev_string)) {
            let song = await chrome.storage.local.get(["song_string", "song_artist", "song_track", "song_start", "song_scrobbled"]);
            // console.log(song);
            if(prev_string == song.song_string && !song.song_scrobbled){
                let result = await lastfm_scrobble(song.song_artist, song.song_track, song.song_start);
            }

            await chrome.storage.local.remove(["song_string", "song_artist", "song_track", "song_start", "song_scrobbled"]);
        }

        // Check if our current text is non default, if so, save song details
        if(!default_texts.includes(cur_string)){
            let date = new Date();
            let tmp = cur_string.split(" - ");
            let search = await lastfm_search_song(tmp[0], tmp[1]);
            if(search == undefined){
                await chrome.storage.local.set({
                    song_string: cur_string,
                    song_artist: tmp[0],
                    song_track: tmp[1],
                    song_start: Math.round(date.getTime()/1000),
                    song_scrobbled: false
                });
            }
            else{
                await chrome.storage.local.set({
                    song_string: cur_string,
                    song_artist: search.artist,
                    song_track: search.name,
                    song_start: Math.round(date.getTime()/1000),
                    song_scrobbled: false
                });
            }
        }
    }

    // If the current text is non default we should set now playing on Last FM
    if(!default_texts.includes(cur_string)){
        let data = await chrome.storage.local.get(["song_artist", "song_track"]);
        await lastfm_set_now_playing(data.song_artist, data.song_track);
    }

    // Save our current string for the next iteration
    await chrome.storage.local.set({prev_scraped_string: cur_string});
}


// LastFM calls
/**
 * Sets the 'Now Scrobbling' status of the LastFM user to the provided song
 * @param artist The name of the artist being played
 * @param track The name of the song being played
 */
async function lastfm_set_now_playing(artist, track) {
    let settings = await load_settings();
    let data = {
        method: "track.updateNowPlaying",
        artist: artist,
        track: track,
        api_key: settings.API_KEY,
        sk: settings.session_key,
        format: "json"
    }
    let sig = await lastfm_signature(data, settings.API_SECRET);
    data['api_sig'] = sig;
    let result = await post(lastfm_base_url, data);
    if(!result.nowplaying){
        console.log("lastfm_set_now_playing error", data);
    }
    else{
        console.log("LastFM: set now Scrobbling '" + artist + " - " + track + "'");
    }
}

/**
 * Searches for the provided song on LastFM, and return the most relevant result
 * @param artist The name of the artist
 * @param track The name of the song
 * @returns object A song object which best correspondents the search parameters
 */
async function lastfm_search_song(artist, track){
    let settings = await load_settings();
    let data = {
        method: "track.search",
        artist: artist,
        track: track,
        limit: 1,
        api_key: settings.API_KEY,
        format: 'json'
    };
    let result = await get(lastfm_base_url, data);
    return result.results.trackmatches.track[0];
}

/**
 * Scrobble the provided song on LastFM
 * @param artist The name of the artist of the song being scrobbled
 * @param track The name of the song being scrobbled
 * @param timestamp The UTC UNIX timestamp at which the song started playing
 */
async function lastfm_scrobble(artist, track, timestamp){
    let settings = await load_settings();
    let data = {
        method: "track.scrobble",
        artist: artist,
        track: track,
        chosenByUser: '0',
        timestamp: timestamp,
        api_key: settings.API_KEY,
        sk: settings.session_key,
        format: 'json'
    }
    let sig = await lastfm_signature(data, settings.API_SECRET);
    data['api_sig'] = sig;
    // console.log(data);
    let result = await post(lastfm_base_url, data);
    // console.log(result);
    console.log("LastFM: scrobbled '" + artist + " - " + track + "'");
}


/**
 * SUPPORT METHODS
 * I haven't found a way yet to import support_methods.js, so for now i just copied it.
 * TODO: Find a way to import support_methods.js in background.js
 */

// Global settings
// Kink
const stream_urls = ["https://kink.nl/player?stream=stream.kink"];
const default_texts = ["KINK - No alternative", undefined]

// Last.FM API
const lastfm_base_url = "https://ws.audioscrobbler.com/2.0/";

async function load_settings(){
    let config = await fetch("config.json").then( (response) => { return response.json(); });
    let session_key = await chrome.storage.local.get("session_key");

    await Promise.all([config, session_key]);

    if(session_key.session_key)
        config['session_key'] = session_key.session_key;
    return config;
}

async function get(url, data) {
    url = url + "?" + new URLSearchParams(data).toString();
    // console.log("get", url);
    return fetch(url).then( (response) => { return response.json() });
}

async function post(url, data) {
    let options = {
        method: "POST",
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
        },
        body: new URLSearchParams(data)
    };
    return await fetch(url, options).then(async (response) => {
        return response.json()
    });
}

async function lastfm_signature(params, secret){
    let sorted_keys = Object.keys(params).sort();
    let result = "";
    for(let i = 0; i < sorted_keys.length; i++){
        let k = sorted_keys[i];
        if(k == "format")
            continue;
        result += k + params[k];
    }
    // console.log("lastfm signature ", result + secret, MD5(result + secret));
    return MD5(result + secret);
}

/**
 * Method copied from StackOverflow
 * https://stackoverflow.com/a/33486055
 */
var MD5 = function(d){var r = M(V(Y(X(d),8*d.length)));return r.toLowerCase()};function M(d){for(var _,m="0123456789ABCDEF",f="",r=0;r<d.length;r++)_=d.charCodeAt(r),f+=m.charAt(_>>>4&15)+m.charAt(15&_);return f}function X(d){for(var _=Array(d.length>>2),m=0;m<_.length;m++)_[m]=0;for(m=0;m<8*d.length;m+=8)_[m>>5]|=(255&d.charCodeAt(m/8))<<m%32;return _}function V(d){for(var _="",m=0;m<32*d.length;m+=8)_+=String.fromCharCode(d[m>>5]>>>m%32&255);return _}function Y(d,_){d[_>>5]|=128<<_%32,d[14+(_+64>>>9<<4)]=_;for(var m=1732584193,f=-271733879,r=-1732584194,i=271733878,n=0;n<d.length;n+=16){var h=m,t=f,g=r,e=i;f=md5_ii(f=md5_ii(f=md5_ii(f=md5_ii(f=md5_hh(f=md5_hh(f=md5_hh(f=md5_hh(f=md5_gg(f=md5_gg(f=md5_gg(f=md5_gg(f=md5_ff(f=md5_ff(f=md5_ff(f=md5_ff(f,r=md5_ff(r,i=md5_ff(i,m=md5_ff(m,f,r,i,d[n+0],7,-680876936),f,r,d[n+1],12,-389564586),m,f,d[n+2],17,606105819),i,m,d[n+3],22,-1044525330),r=md5_ff(r,i=md5_ff(i,m=md5_ff(m,f,r,i,d[n+4],7,-176418897),f,r,d[n+5],12,1200080426),m,f,d[n+6],17,-1473231341),i,m,d[n+7],22,-45705983),r=md5_ff(r,i=md5_ff(i,m=md5_ff(m,f,r,i,d[n+8],7,1770035416),f,r,d[n+9],12,-1958414417),m,f,d[n+10],17,-42063),i,m,d[n+11],22,-1990404162),r=md5_ff(r,i=md5_ff(i,m=md5_ff(m,f,r,i,d[n+12],7,1804603682),f,r,d[n+13],12,-40341101),m,f,d[n+14],17,-1502002290),i,m,d[n+15],22,1236535329),r=md5_gg(r,i=md5_gg(i,m=md5_gg(m,f,r,i,d[n+1],5,-165796510),f,r,d[n+6],9,-1069501632),m,f,d[n+11],14,643717713),i,m,d[n+0],20,-373897302),r=md5_gg(r,i=md5_gg(i,m=md5_gg(m,f,r,i,d[n+5],5,-701558691),f,r,d[n+10],9,38016083),m,f,d[n+15],14,-660478335),i,m,d[n+4],20,-405537848),r=md5_gg(r,i=md5_gg(i,m=md5_gg(m,f,r,i,d[n+9],5,568446438),f,r,d[n+14],9,-1019803690),m,f,d[n+3],14,-187363961),i,m,d[n+8],20,1163531501),r=md5_gg(r,i=md5_gg(i,m=md5_gg(m,f,r,i,d[n+13],5,-1444681467),f,r,d[n+2],9,-51403784),m,f,d[n+7],14,1735328473),i,m,d[n+12],20,-1926607734),r=md5_hh(r,i=md5_hh(i,m=md5_hh(m,f,r,i,d[n+5],4,-378558),f,r,d[n+8],11,-2022574463),m,f,d[n+11],16,1839030562),i,m,d[n+14],23,-35309556),r=md5_hh(r,i=md5_hh(i,m=md5_hh(m,f,r,i,d[n+1],4,-1530992060),f,r,d[n+4],11,1272893353),m,f,d[n+7],16,-155497632),i,m,d[n+10],23,-1094730640),r=md5_hh(r,i=md5_hh(i,m=md5_hh(m,f,r,i,d[n+13],4,681279174),f,r,d[n+0],11,-358537222),m,f,d[n+3],16,-722521979),i,m,d[n+6],23,76029189),r=md5_hh(r,i=md5_hh(i,m=md5_hh(m,f,r,i,d[n+9],4,-640364487),f,r,d[n+12],11,-421815835),m,f,d[n+15],16,530742520),i,m,d[n+2],23,-995338651),r=md5_ii(r,i=md5_ii(i,m=md5_ii(m,f,r,i,d[n+0],6,-198630844),f,r,d[n+7],10,1126891415),m,f,d[n+14],15,-1416354905),i,m,d[n+5],21,-57434055),r=md5_ii(r,i=md5_ii(i,m=md5_ii(m,f,r,i,d[n+12],6,1700485571),f,r,d[n+3],10,-1894986606),m,f,d[n+10],15,-1051523),i,m,d[n+1],21,-2054922799),r=md5_ii(r,i=md5_ii(i,m=md5_ii(m,f,r,i,d[n+8],6,1873313359),f,r,d[n+15],10,-30611744),m,f,d[n+6],15,-1560198380),i,m,d[n+13],21,1309151649),r=md5_ii(r,i=md5_ii(i,m=md5_ii(m,f,r,i,d[n+4],6,-145523070),f,r,d[n+11],10,-1120210379),m,f,d[n+2],15,718787259),i,m,d[n+9],21,-343485551),m=safe_add(m,h),f=safe_add(f,t),r=safe_add(r,g),i=safe_add(i,e)}return Array(m,f,r,i)}function md5_cmn(d,_,m,f,r,i){return safe_add(bit_rol(safe_add(safe_add(_,d),safe_add(f,i)),r),m)}function md5_ff(d,_,m,f,r,i,n){return md5_cmn(_&m|~_&f,d,_,r,i,n)}function md5_gg(d,_,m,f,r,i,n){return md5_cmn(_&f|m&~f,d,_,r,i,n)}function md5_hh(d,_,m,f,r,i,n){return md5_cmn(_^m^f,d,_,r,i,n)}function md5_ii(d,_,m,f,r,i,n){return md5_cmn(m^(_|~f),d,_,r,i,n)}function safe_add(d,_){var m=(65535&d)+(65535&_);return(d>>16)+(_>>16)+(m>>16)<<16|65535&m}function bit_rol(d,_){return d<<_|d>>>32-_}
