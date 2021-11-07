create_page().then(r => { });

async function create_page(){
    let settings = await load_settings();
    let generate_key_url = "http://www.last.fm/api/auth/?api_key=" + settings.API_KEY;
    $("div#add_keys a#generate_keys").click(async (e) => {
        e.preventDefault();
        let cb = await chrome.identity.getRedirectURL();
        generate_key_url = generate_key_url + "&cb=" + encodeURI(cb);
        await chrome.identity.launchWebAuthFlow({url: generate_key_url, interactive: true}, key_generation_callback);
    });

    let keys_set = await chrome.storage.local.get("session_key");
    if(keys_set.session_key){
        $("div#has_keys").show();
    }
    else{
        $("div#add_keys").show();
    }
}

async function key_generation_callback(return_url){
    // Retrieve the token from the URL
    let settings = await load_settings();
    let url = new URL(return_url);
    let token = url.searchParams.get("token");

    // Create signature
    let data = {
        method: "auth.getSession",
        api_key: settings.API_KEY,
        token: token,
    }
    let sig = await lastfm_signature(data, settings.API_SECRET);

    // Create session
    data = {
        ...data,
        api_sig: sig,
        format: "json"
    }
    console.log(data);
    let response = await get(lastfm_base_url, data);
    console.log(response);
    console.log("session key", response.session.key);
    // TODO: This should at some point be stored somewhere else. Google explicitly warns not to store sensitive data in the storage.
    await chrome.storage.local.set({"session_key": response.session.key});
    $("div#add_keys").hide();
    $("div#keys_generated").show();
}

