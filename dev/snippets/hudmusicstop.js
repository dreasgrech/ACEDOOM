/*
 * hudmusicstop.js -- can we STOP the looping HUD music? Dev console, in a session:
 *
 *     .run hudmusicstop
 *
 * E1M1 is in the pneumatic slot, played by GUI_PART_APPLY. GUI_PART_REMOVE is the same gui_garage
 * event with no sample. This starts the music, waits 12 s, then fires GUI_PART_REMOVE. Tell me:
 * did the music STOP when step 2 fired, keep playing, or restart?
 */
(function () {
    const log = function (text) { console.log("[hudmusicstop] " + text); };
    const NAME = "UIAudioRequestAudioEvent";

    if (typeof engine === "undefined" || !engine.trigger) {
        log("no engine on this page");
        return;
    }

    log("1: GUI_PART_APPLY -- E1M1 should start and loop");
    engine.trigger("OnUICommand", NAME, { __Type: NAME, type: "GUI_PART_APPLY" });

    setTimeout(function () {
        log("2: GUI_PART_REMOVE -- did the music stop?");
        engine.trigger("OnUICommand", NAME, { __Type: NAME, type: "GUI_PART_REMOVE" });
    }, 12000);

    setTimeout(function () { log("done: did step 2 stop the music, or is it still playing?"); }, 16000);
}());
