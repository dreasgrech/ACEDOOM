/*
 * guisounddisc.js -- map GUI event type -> sample, definitively. Dev console:
 *
 *     .run guisounddisc
 *
 * Each of the seven stock samples the livery-editor event plays now holds ONE distinct DOOM
 * sound. This requests the eight garage GUI types four seconds apart. For each number, tell
 * me which letter you heard:
 *
 *     A) gunshot crack (pistol)         E) gurgling monster death
 *     B) door sliding open              F) mechanical ka-chunk (shotgun cock)
 *     C) explosion boom                 G) deep shotgun boom
 *     D) short human 'urgh' grunt       -) nothing / silence
 */
(function () {
    const log = function (text) { console.log("[guisounddisc] " + text); };
    const NAME = "UIAudioRequestAudioEvent";
    const TYPES = ["GUI_PAINT_APPLY", "GUI_PAINT_REMOVE", "GUI_STICKER_APPLY", "GUI_STICKER_REMOVE",
        "GUI_PART_APPLY", "GUI_PART_REMOVE", "GUI_WHEEL_APPLY", "GUI_WHEEL_REMOVE"];

    if (typeof engine === "undefined" || !engine.trigger) {
        log("no engine on this page");
        return;
    }

    TYPES.forEach(function (type, index) {
        setTimeout(function () {
            log((index + 1) + " of 8: " + type + "  ->  which letter? A gunshot / B door / C explosion / D grunt / E monster death / F ka-chunk / G shotgun / - silent");
            engine.trigger("OnUICommand", NAME, { __Type: NAME, type: type });
        }, index * 4000);
    });

    setTimeout(function () { log("done: report the eight letters in order (e.g. A B C D E F G -)"); }, TYPES.length * 4000 + 500);
}());
