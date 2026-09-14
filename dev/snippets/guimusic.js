/*
 * guimusic.js -- does UI music play DOOM's E1M1, and via which GUI_MUSIC_* type? Dev console:
 *
 *     .run guimusic
 *
 * EXPERIMENT: every UI music track in the bank is now DOOM's E1M1 ("At Doom's Gate", the fast
 * metal riff), so there is no randomness: if a music type plays anything, it is E1M1. Fires the
 * three mapped music types (MENU=0, GAMEPLAY=1, END=2) eight seconds apart, twice, and logs the
 * game's UIAudioResponseEvent for each. Tell me which numbers played E1M1, and paste the
 * [guimusic] response lines. Also say whether the menu music was already E1M1 before this.
 */
(function () {
    const log = function (text) { console.log("[guimusic] " + text); };
    const NAME = "UIAudioRequestAudioEvent";
    const RESPONSE = "UIAudioResponseEvent";
    const TYPES = ["GUI_MUSIC_MENU", "GUI_MUSIC_GAMEPLAY", "GUI_MUSIC_END",
        "GUI_MUSIC_MENU", "GUI_MUSIC_GAMEPLAY", "GUI_MUSIC_END"];

    if (typeof engine === "undefined" || !engine.trigger) {
        log("no engine on this page");
        return;
    }

    const handler = engine.on(RESPONSE, function (response) {
        log("response: " + JSON.stringify(response));
    });

    TYPES.forEach(function (type, index) {
        setTimeout(function () {
            log((index + 1) + " of 6: " + type + "  -> listen ~8 s for the E1M1 riff");
            engine.trigger("OnUICommand", NAME, { __Type: NAME, type: type });
        }, index * 8000);
    });

    setTimeout(function () {
        if (handler && handler.clear) { handler.clear(); }
        log("done: which numbers played E1M1?");
    }, TYPES.length * 8000 + 500);
}());
