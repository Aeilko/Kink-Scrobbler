// Chrome extension listeners
/**
 * Reset the extension once updated
 */
chrome.runtime.onInstalled.addListener(async (details) => {
    console.log(details.reason);
    await reset();

    // Check if there is anything left
    console.log("Storage should only contain the session_key", await chrome.storage.local.get(null));
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

            // Set the scraper to run on 1 minute intervals, and run it directly
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
    let storage = chrome.storage.local.remove(["windowId", "prev_scraped_string", "song_string", "song_artist", "song_track", "song_start", "song_scrobbled", "history"]);
    await Promise.all([alarm, storage]);
}

/**
 * Entry point of this extension's main loop
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
 * Part of this extension's main loop, will be triggered by the message sent from the content_script on the stream page.
 * Will process the scraped information, and make the corresponding LastFM calls.
 * @param request Contains the message which triggered the method
 * @param sender Contains information about the sender
 * @param sendResponse
 */
async function handle_scraper(request, sender, sendResponse) {
    // Check if this is a message from the scraper
    if(sender.url != "https://kink.nl/player?stream=stream.kink" && sender.url != "https://kink.nl/player/stream.kink") {
        console.log("handle_scraper: wrong sender");
        console.log(sender);
        return
    }
    // Callback happened, remove myself as listener
    chrome.runtime.onMessage.removeListener(handle_scraper);

    // Load stored data
    let prev_string = chrome.storage.local.get("prev_scraped_string");
    let prev_song = chrome.storage.local.get(["song_string", "song_artist", "song_track", "song_start", "song_scrobbled"]);
    let history = chrome.storage.local.get("history");

    [prev_string, prev_song, history] = await Promise.all([prev_string, prev_song, history]);

    prev_string = prev_string.prev_scraped_string;
    history = (history.history == undefined ? Array(5).fill(null) : history.history);

    // Check the scraped text and compare it to the last scraped text.
    // If the scraped text has been recently played it's probably a mistake, so we ignore it.
    let cur_string = request.result;
    if(prev_string != cur_string && !history.includes(cur_string)){
        // Scraped text differs from previous text
        console.log("Scraped new text:", cur_string);

        // Check if previous text was a non default text, if so, scrobble the song and remove details from storage
        if(!default_texts.includes(prev_string)) {
            // console.log(prev_song);
            if(prev_string == prev_song.song_string && !prev_song.song_scrobbled){
                history.shift();
                history.push(prev_string);
                await chrome.storage.local.set({history: history});
                let result = await lastfm_scrobble(prev_song.song_artist, prev_song.song_track, prev_song.song_start);
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

            // Update Now Playing on LastFM
            let data = await chrome.storage.local.get(["song_artist", "song_track"]);
            await lastfm_set_now_playing(data.song_artist, data.song_track)
        }
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
        console.log("result", result);
    }
    else{
        console.log("LastFM (now playing): '" + artist + " - " + track + "'");
    }
}

/**
 * Searches for the provided song on LastFM, and return the most relevant result
 * @param artist The name of the artist
 * @param track The name of the song
 * @returns object A song object which best matches the search parameters
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
    console.log("LastFM (scrobble): '" + artist + " - " + track + "'");
}


/**
 * SUPPORT METHODS
 * I haven't found a way yet to import support_methods.js, so for now i just copied it.
 * TODO: Find a way to import support_methods.js in background.js
 */

// Global settings
// Kink
const stream_urls = ["https://kink.nl/player/stream.kink", "https://kink.nl/player?stream=stream.kink"];
const default_texts = ["KINK - No alternative", undefined]

// Last.FM API
const lastfm_base_url = "https://ws.audioscrobbler.com/2.0/";

async function load_settings(){
    // TODO Add check for non existent config file.
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
    result = result + secret
    // console.log("lastfm signature", result, MD5(result));
    return MD5(result);
}

/**
 * Method copied from StackOverflow
 * https://stackoverflow.com/a/14129417
 */
var MD5 = function (string) {
    function RotateLeft(lValue, iShiftBits) {
        return (lValue<<iShiftBits) | (lValue>>>(32-iShiftBits));
    }

    function AddUnsigned(lX,lY) {
        var lX4,lY4,lX8,lY8,lResult;
        lX8 = (lX & 0x80000000);
        lY8 = (lY & 0x80000000);
        lX4 = (lX & 0x40000000);
        lY4 = (lY & 0x40000000);
        lResult = (lX & 0x3FFFFFFF)+(lY & 0x3FFFFFFF);
        if (lX4 & lY4) {
            return (lResult ^ 0x80000000 ^ lX8 ^ lY8);
        }
        if (lX4 | lY4) {
            if (lResult & 0x40000000) {
                return (lResult ^ 0xC0000000 ^ lX8 ^ lY8);
            } else {
                return (lResult ^ 0x40000000 ^ lX8 ^ lY8);
            }
        } else {
            return (lResult ^ lX8 ^ lY8);
        }
    }

    function F(x,y,z) { return (x & y) | ((~x) & z); }
    function G(x,y,z) { return (x & z) | (y & (~z)); }
    function H(x,y,z) { return (x ^ y ^ z); }
    function I(x,y,z) { return (y ^ (x | (~z))); }

    function FF(a,b,c,d,x,s,ac) {
        a = AddUnsigned(a, AddUnsigned(AddUnsigned(F(b, c, d), x), ac));
        return AddUnsigned(RotateLeft(a, s), b);
    };
    function GG(a,b,c,d,x,s,ac) {
        a = AddUnsigned(a, AddUnsigned(AddUnsigned(G(b, c, d), x), ac));
        return AddUnsigned(RotateLeft(a, s), b);
    };
    function HH(a,b,c,d,x,s,ac) {
        a = AddUnsigned(a, AddUnsigned(AddUnsigned(H(b, c, d), x), ac));
        return AddUnsigned(RotateLeft(a, s), b);
    };
    function II(a,b,c,d,x,s,ac) {
        a = AddUnsigned(a, AddUnsigned(AddUnsigned(I(b, c, d), x), ac));
        return AddUnsigned(RotateLeft(a, s), b);
    };

    function ConvertToWordArray(string) {
        var lWordCount;
        var lMessageLength = string.length;
        var lNumberOfWords_temp1=lMessageLength + 8;
        var lNumberOfWords_temp2=(lNumberOfWords_temp1-(lNumberOfWords_temp1 % 64))/64;
        var lNumberOfWords = (lNumberOfWords_temp2+1)*16;
        var lWordArray=Array(lNumberOfWords-1);
        var lBytePosition = 0;
        var lByteCount = 0;
        while ( lByteCount < lMessageLength ) {
            lWordCount = (lByteCount-(lByteCount % 4))/4;
            lBytePosition = (lByteCount % 4)*8;
            lWordArray[lWordCount] = (lWordArray[lWordCount] | (string.charCodeAt(lByteCount)<<lBytePosition));
            lByteCount++;
        }
        lWordCount = (lByteCount-(lByteCount % 4))/4;
        lBytePosition = (lByteCount % 4)*8;
        lWordArray[lWordCount] = lWordArray[lWordCount] | (0x80<<lBytePosition);
        lWordArray[lNumberOfWords-2] = lMessageLength<<3;
        lWordArray[lNumberOfWords-1] = lMessageLength>>>29;
        return lWordArray;
    };

    function WordToHex(lValue) {
        var WordToHexValue="",WordToHexValue_temp="",lByte,lCount;
        for (lCount = 0;lCount<=3;lCount++) {
            lByte = (lValue>>>(lCount*8)) & 255;
            WordToHexValue_temp = "0" + lByte.toString(16);
            WordToHexValue = WordToHexValue + WordToHexValue_temp.substr(WordToHexValue_temp.length-2,2);
        }
        return WordToHexValue;
    };

    function Utf8Encode(string) {
        string = string.replace(/\r\n/g,"\n");
        var utftext = "";
        for (var n = 0; n < string.length; n++) {
            var c = string.charCodeAt(n);
            if (c < 128) {
                utftext += String.fromCharCode(c);
            }
            else if((c > 127) && (c < 2048)) {
                utftext += String.fromCharCode((c >> 6) | 192);
                utftext += String.fromCharCode((c & 63) | 128);
            }
            else {
                utftext += String.fromCharCode((c >> 12) | 224);
                utftext += String.fromCharCode(((c >> 6) & 63) | 128);
                utftext += String.fromCharCode((c & 63) | 128);
            }
        }
        return utftext;
    };

    var x=Array();
    var k,AA,BB,CC,DD,a,b,c,d;
    var S11=7, S12=12, S13=17, S14=22;
    var S21=5, S22=9 , S23=14, S24=20;
    var S31=4, S32=11, S33=16, S34=23;
    var S41=6, S42=10, S43=15, S44=21;

    string = Utf8Encode(string);
    x = ConvertToWordArray(string);
    a = 0x67452301; b = 0xEFCDAB89; c = 0x98BADCFE; d = 0x10325476;

    for (k=0;k<x.length;k+=16) {
        AA=a; BB=b; CC=c; DD=d;
        a=FF(a,b,c,d,x[k+0], S11,0xD76AA478);
        d=FF(d,a,b,c,x[k+1], S12,0xE8C7B756);
        c=FF(c,d,a,b,x[k+2], S13,0x242070DB);
        b=FF(b,c,d,a,x[k+3], S14,0xC1BDCEEE);
        a=FF(a,b,c,d,x[k+4], S11,0xF57C0FAF);
        d=FF(d,a,b,c,x[k+5], S12,0x4787C62A);
        c=FF(c,d,a,b,x[k+6], S13,0xA8304613);
        b=FF(b,c,d,a,x[k+7], S14,0xFD469501);
        a=FF(a,b,c,d,x[k+8], S11,0x698098D8);
        d=FF(d,a,b,c,x[k+9], S12,0x8B44F7AF);
        c=FF(c,d,a,b,x[k+10],S13,0xFFFF5BB1);
        b=FF(b,c,d,a,x[k+11],S14,0x895CD7BE);
        a=FF(a,b,c,d,x[k+12],S11,0x6B901122);
        d=FF(d,a,b,c,x[k+13],S12,0xFD987193);
        c=FF(c,d,a,b,x[k+14],S13,0xA679438E);
        b=FF(b,c,d,a,x[k+15],S14,0x49B40821);
        a=GG(a,b,c,d,x[k+1], S21,0xF61E2562);
        d=GG(d,a,b,c,x[k+6], S22,0xC040B340);
        c=GG(c,d,a,b,x[k+11],S23,0x265E5A51);
        b=GG(b,c,d,a,x[k+0], S24,0xE9B6C7AA);
        a=GG(a,b,c,d,x[k+5], S21,0xD62F105D);
        d=GG(d,a,b,c,x[k+10],S22,0x2441453);
        c=GG(c,d,a,b,x[k+15],S23,0xD8A1E681);
        b=GG(b,c,d,a,x[k+4], S24,0xE7D3FBC8);
        a=GG(a,b,c,d,x[k+9], S21,0x21E1CDE6);
        d=GG(d,a,b,c,x[k+14],S22,0xC33707D6);
        c=GG(c,d,a,b,x[k+3], S23,0xF4D50D87);
        b=GG(b,c,d,a,x[k+8], S24,0x455A14ED);
        a=GG(a,b,c,d,x[k+13],S21,0xA9E3E905);
        d=GG(d,a,b,c,x[k+2], S22,0xFCEFA3F8);
        c=GG(c,d,a,b,x[k+7], S23,0x676F02D9);
        b=GG(b,c,d,a,x[k+12],S24,0x8D2A4C8A);
        a=HH(a,b,c,d,x[k+5], S31,0xFFFA3942);
        d=HH(d,a,b,c,x[k+8], S32,0x8771F681);
        c=HH(c,d,a,b,x[k+11],S33,0x6D9D6122);
        b=HH(b,c,d,a,x[k+14],S34,0xFDE5380C);
        a=HH(a,b,c,d,x[k+1], S31,0xA4BEEA44);
        d=HH(d,a,b,c,x[k+4], S32,0x4BDECFA9);
        c=HH(c,d,a,b,x[k+7], S33,0xF6BB4B60);
        b=HH(b,c,d,a,x[k+10],S34,0xBEBFBC70);
        a=HH(a,b,c,d,x[k+13],S31,0x289B7EC6);
        d=HH(d,a,b,c,x[k+0], S32,0xEAA127FA);
        c=HH(c,d,a,b,x[k+3], S33,0xD4EF3085);
        b=HH(b,c,d,a,x[k+6], S34,0x4881D05);
        a=HH(a,b,c,d,x[k+9], S31,0xD9D4D039);
        d=HH(d,a,b,c,x[k+12],S32,0xE6DB99E5);
        c=HH(c,d,a,b,x[k+15],S33,0x1FA27CF8);
        b=HH(b,c,d,a,x[k+2], S34,0xC4AC5665);
        a=II(a,b,c,d,x[k+0], S41,0xF4292244);
        d=II(d,a,b,c,x[k+7], S42,0x432AFF97);
        c=II(c,d,a,b,x[k+14],S43,0xAB9423A7);
        b=II(b,c,d,a,x[k+5], S44,0xFC93A039);
        a=II(a,b,c,d,x[k+12],S41,0x655B59C3);
        d=II(d,a,b,c,x[k+3], S42,0x8F0CCC92);
        c=II(c,d,a,b,x[k+10],S43,0xFFEFF47D);
        b=II(b,c,d,a,x[k+1], S44,0x85845DD1);
        a=II(a,b,c,d,x[k+8], S41,0x6FA87E4F);
        d=II(d,a,b,c,x[k+15],S42,0xFE2CE6E0);
        c=II(c,d,a,b,x[k+6], S43,0xA3014314);
        b=II(b,c,d,a,x[k+13],S44,0x4E0811A1);
        a=II(a,b,c,d,x[k+4], S41,0xF7537E82);
        d=II(d,a,b,c,x[k+11],S42,0xBD3AF235);
        c=II(c,d,a,b,x[k+2], S43,0x2AD7D2BB);
        b=II(b,c,d,a,x[k+9], S44,0xEB86D391);
        a=AddUnsigned(a,AA);
        b=AddUnsigned(b,BB);
        c=AddUnsigned(c,CC);
        d=AddUnsigned(d,DD);
    }

    var temp = WordToHex(a)+WordToHex(b)+WordToHex(c)+WordToHex(d);
    return temp.toLowerCase();
}

/**
 * Method copied from StackOverflow
 * https://stackoverflow.com/a/33486055
 */
var MD5_old = function(d){var r = M(V(Y(X(d),8*d.length)));return r.toLowerCase()};function M(d){for(var _,m="0123456789ABCDEF",f="",r=0;r<d.length;r++)_=d.charCodeAt(r),f+=m.charAt(_>>>4&15)+m.charAt(15&_);return f}function X(d){for(var _=Array(d.length>>2),m=0;m<_.length;m++)_[m]=0;for(m=0;m<8*d.length;m+=8)_[m>>5]|=(255&d.charCodeAt(m/8))<<m%32;return _}function V(d){for(var _="",m=0;m<32*d.length;m+=8)_+=String.fromCharCode(d[m>>5]>>>m%32&255);return _}function Y(d,_){d[_>>5]|=128<<_%32,d[14+(_+64>>>9<<4)]=_;for(var m=1732584193,f=-271733879,r=-1732584194,i=271733878,n=0;n<d.length;n+=16){var h=m,t=f,g=r,e=i;f=md5_ii(f=md5_ii(f=md5_ii(f=md5_ii(f=md5_hh(f=md5_hh(f=md5_hh(f=md5_hh(f=md5_gg(f=md5_gg(f=md5_gg(f=md5_gg(f=md5_ff(f=md5_ff(f=md5_ff(f=md5_ff(f,r=md5_ff(r,i=md5_ff(i,m=md5_ff(m,f,r,i,d[n+0],7,-680876936),f,r,d[n+1],12,-389564586),m,f,d[n+2],17,606105819),i,m,d[n+3],22,-1044525330),r=md5_ff(r,i=md5_ff(i,m=md5_ff(m,f,r,i,d[n+4],7,-176418897),f,r,d[n+5],12,1200080426),m,f,d[n+6],17,-1473231341),i,m,d[n+7],22,-45705983),r=md5_ff(r,i=md5_ff(i,m=md5_ff(m,f,r,i,d[n+8],7,1770035416),f,r,d[n+9],12,-1958414417),m,f,d[n+10],17,-42063),i,m,d[n+11],22,-1990404162),r=md5_ff(r,i=md5_ff(i,m=md5_ff(m,f,r,i,d[n+12],7,1804603682),f,r,d[n+13],12,-40341101),m,f,d[n+14],17,-1502002290),i,m,d[n+15],22,1236535329),r=md5_gg(r,i=md5_gg(i,m=md5_gg(m,f,r,i,d[n+1],5,-165796510),f,r,d[n+6],9,-1069501632),m,f,d[n+11],14,643717713),i,m,d[n+0],20,-373897302),r=md5_gg(r,i=md5_gg(i,m=md5_gg(m,f,r,i,d[n+5],5,-701558691),f,r,d[n+10],9,38016083),m,f,d[n+15],14,-660478335),i,m,d[n+4],20,-405537848),r=md5_gg(r,i=md5_gg(i,m=md5_gg(m,f,r,i,d[n+9],5,568446438),f,r,d[n+14],9,-1019803690),m,f,d[n+3],14,-187363961),i,m,d[n+8],20,1163531501),r=md5_gg(r,i=md5_gg(i,m=md5_gg(m,f,r,i,d[n+13],5,-1444681467),f,r,d[n+2],9,-51403784),m,f,d[n+7],14,1735328473),i,m,d[n+12],20,-1926607734),r=md5_hh(r,i=md5_hh(i,m=md5_hh(m,f,r,i,d[n+5],4,-378558),f,r,d[n+8],11,-2022574463),m,f,d[n+11],16,1839030562),i,m,d[n+14],23,-35309556),r=md5_hh(r,i=md5_hh(i,m=md5_hh(m,f,r,i,d[n+1],4,-1530992060),f,r,d[n+4],11,1272893353),m,f,d[n+7],16,-155497632),i,m,d[n+10],23,-1094730640),r=md5_hh(r,i=md5_hh(i,m=md5_hh(m,f,r,i,d[n+13],4,681279174),f,r,d[n+0],11,-358537222),m,f,d[n+3],16,-722521979),i,m,d[n+6],23,76029189),r=md5_hh(r,i=md5_hh(i,m=md5_hh(m,f,r,i,d[n+9],4,-640364487),f,r,d[n+12],11,-421815835),m,f,d[n+15],16,530742520),i,m,d[n+2],23,-995338651),r=md5_ii(r,i=md5_ii(i,m=md5_ii(m,f,r,i,d[n+0],6,-198630844),f,r,d[n+7],10,1126891415),m,f,d[n+14],15,-1416354905),i,m,d[n+5],21,-57434055),r=md5_ii(r,i=md5_ii(i,m=md5_ii(m,f,r,i,d[n+12],6,1700485571),f,r,d[n+3],10,-1894986606),m,f,d[n+10],15,-1051523),i,m,d[n+1],21,-2054922799),r=md5_ii(r,i=md5_ii(i,m=md5_ii(m,f,r,i,d[n+8],6,1873313359),f,r,d[n+15],10,-30611744),m,f,d[n+6],15,-1560198380),i,m,d[n+13],21,1309151649),r=md5_ii(r,i=md5_ii(i,m=md5_ii(m,f,r,i,d[n+4],6,-145523070),f,r,d[n+11],10,-1120210379),m,f,d[n+2],15,718787259),i,m,d[n+9],21,-343485551),m=safe_add(m,h),f=safe_add(f,t),r=safe_add(r,g),i=safe_add(i,e)}return Array(m,f,r,i)}function md5_cmn(d,_,m,f,r,i){return safe_add(bit_rol(safe_add(safe_add(_,d),safe_add(f,i)),r),m)}function md5_ff(d,_,m,f,r,i,n){return md5_cmn(_&m|~_&f,d,_,r,i,n)}function md5_gg(d,_,m,f,r,i,n){return md5_cmn(_&f|m&~f,d,_,r,i,n)}function md5_hh(d,_,m,f,r,i,n){return md5_cmn(_^m^f,d,_,r,i,n)}function md5_ii(d,_,m,f,r,i,n){return md5_cmn(m^(_|~f),d,_,r,i,n)}function safe_add(d,_){var m=(65535&d)+(65535&_);return(d>>16)+(_>>16)+(m>>16)<<16|65535&m}function bit_rol(d,_){return d<<_|d>>>32-_}
