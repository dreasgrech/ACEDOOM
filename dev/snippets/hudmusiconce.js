/*
 * hudmusiconce.js -- is the HUD music a one-shot (1:43) or a forever loop? Dev console, in a session:
 *
 *     .run hudmusiconce
 *
 * Fires E1M1 ONCE and does nothing else. Do NOT re-run it. Just listen. It logs a countdown.
 * E1M1 is 1:43 (103 s). Tell me: does the music STOP on its own around 1:43, or keep playing past 2 min?
 */
(function () {
    const log = function (text) { console.log("[hudmusiconce] " + text); };
    const NAME = "UIAudioRequestAudioEvent";

    if (typeof engine === "undefined" || !engine.trigger) {
        log("no engine on this page");
        return;
    }

    log("firing E1M1 once at 0:00 -- do not touch anything; report if it stops near 1:43");
    engine.trigger("OnUICommand", NAME, { __Type: NAME, type: "GUI_PART_APPLY" });

    [30, 60, 90, 100, 103, 110, 120, 150].forEach(function (t) {
        setTimeout(function () { log(t + " s elapsed -- still playing? (E1M1 is 103 s)"); }, t * 1000);
    });
}());
