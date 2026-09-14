/*
 * navdisc.js -- which menu-click type plays which sample? To pick the music slot. Dev console, in a session:
 *
 *     .run navdisc
 *
 * Each gui_navigation (menu-click) sample now holds one distinct DOOM sound. This fires the five
 * click types four seconds apart. For each, tell me the letter you heard:
 *   A gunshot   B shotgun   C door   D explosion   E grunt   F monster death
 *   G ka-chunk  H door-close   I short blip   J pop   - silent
 * I especially need GUI_WARNING (number 2).
 */
(function () {
    const log = function (text) { console.log("[navdisc] " + text); };
    const NAME = "UIAudioRequestAudioEvent";
    const TYPES = ["GUI_SCROLL", "GUI_WARNING", "GUI_SELECT", "GUI_CONFIRM", "GUI_CANCEL"];

    if (typeof engine === "undefined" || !engine.trigger) {
        log("no engine on this page");
        return;
    }

    TYPES.forEach(function (type, index) {
        setTimeout(function () {
            log((index + 1) + " of 5: " + type + "  -> which letter? A gun B shotgun C door D explosion E grunt F monster G ka-chunk H door-close I blip J pop - silent");
            engine.trigger("OnUICommand", NAME, { __Type: NAME, type: type });
        }, index * 4000);
    });

    setTimeout(function () { log("done: report the five letters (esp. #2 GUI_WARNING)"); }, TYPES.length * 4000 + 500);
}());
