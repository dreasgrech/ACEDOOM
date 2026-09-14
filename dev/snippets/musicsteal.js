/*
 * musicsteal.js -- does another livery-editor sound cut the music? Dev console, in a session:
 *
 *     .run musicsteal
 *
 * E1M1 plays via GUI_PART_APPLY. This starts it, then after 6 s fires GUI_WHEEL_REMOVE (the
 * short explosion, a different param of the same gui_garage event), then after another 6 s fires
 * GUI_PAINT_APPLY (the pistol). Tell me, for each step: did the music STOP, keep playing, or restart?
 *   - If a different garage sound stops the music, we can stop it on demand (and shooting would cut it).
 *   - If the music keeps playing through them, garage sounds and music coexist.
 */
(function () {
    const log = function (text) { console.log("[musicsteal] " + text); };
    const NAME = "UIAudioRequestAudioEvent";
    const fire = function (type) { engine.trigger("OnUICommand", NAME, { __Type: NAME, type: type }); };

    if (typeof engine === "undefined" || !engine.trigger) { log("no engine on this page"); return; }

    log("1: GUI_PART_APPLY -- E1M1 starts, let it play");
    fire("GUI_PART_APPLY");
    setTimeout(function () { log("2: GUI_WHEEL_REMOVE (explosion) -- did the music stop?"); fire("GUI_WHEEL_REMOVE"); }, 6000);
    setTimeout(function () { log("3: GUI_PAINT_APPLY (pistol) -- did the music stop?"); fire("GUI_PAINT_APPLY"); }, 12000);
    setTimeout(function () { log("done: for steps 2 and 3, did the music stop, keep playing, or restart?"); }, 16000);
}());
