
console.log("content_script.js");

song = $("div:contains('JE LUISTERT NAAR'):last").parent().children(":last").children(":last").text();
// song = "Pentakill - Mortal";

chrome.runtime.sendMessage({ "result": song });