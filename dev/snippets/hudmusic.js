/*
 * hudmusic.js -- can music play in-session from the HUD, via an EFFECT event? Dev console:
 *
 *     .run hudmusic
 *
 * DOOM's E1M1 is now in the "pneumatic wrench" livery-editor EFFECT sample (GUI_PART_APPLY).
 * Effect events play during a driving session (unlike music events), so this fires GUI_PART_APPLY
 * once and E1M1 should start. Listen for ~10-20 s: does the DOOM riff play while you are in the
 * session? Say whether it plays, how long it lasts, and if it cuts off early.
 */
(function () {
    const log = function (text) { console.log("[hudmusic] " + text); };
    const NAME = "UIAudioRequestAudioEvent";

    if (typeof engine === "undefined" || !engine.trigger) {
        log("no engine on this page");
        return;
    }

    log("firing GUI_PART_APPLY (holds E1M1) -- listen for the DOOM riff in-session");
    engine.trigger("OnUICommand", NAME, { __Type: NAME, type: "GUI_PART_APPLY" });

    setTimeout(function () { log("if you heard E1M1, HUD music works; note how long before it stopped"); }, 4000);
}());
