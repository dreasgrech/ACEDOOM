/*
 * guisoundcheck.js -- confirm the final DOOM sound mapping. Dev console:
 *
 *     .run guisoundcheck
 *
 * Requests each GUI event type three seconds apart and prints what you should hear.
 * The type -> sample map was verified in game (snippets/guisounddisc.js).
 */
(function () {
    const log = function (text) { console.log("[guisoundcheck] " + text); };
    const NAME = "UIAudioRequestAudioEvent";
    const STEPS = [
        ["GUI_CONFIRM", "stock menu confirm click (unchanged)"],
        ["GUI_CANCEL", "stock menu cancel click (unchanged)"],
        ["GUI_PAINT_APPLY", "DOOM pistol shot (weapons fire; also the chaingun)"],
        ["GUI_PAINT_REMOVE", "DOOM shotgun boom (also the super shotgun)"],
        ["GUI_STICKER_APPLY", "DOOM door slide (also switches and lifts)"],
        ["GUI_STICKER_REMOVE", "DOOM pain grunt (also enemy pain)"],
        ["GUI_PART_APPLY", "DOOM pickup pop, short (items, weapons)"],
        ["GUI_PART_REMOVE", "nothing: this type has no sample in the game's bank"],
        ["GUI_WHEEL_APPLY", "DOOM death gurgle (enemy and player deaths)"],
        ["GUI_WHEEL_REMOVE", "DOOM barrel explosion (also rocket blasts)"]
    ];

    if (typeof engine === "undefined" || !engine.trigger) {
        log("no engine on this page");
        return;
    }

    STEPS.forEach(function (step, index) {
        setTimeout(function () {
            log((index + 1) + " of " + STEPS.length + ": " + step[0] + "  ->  expect: " + step[1]);
            engine.trigger("OnUICommand", NAME, { __Type: NAME, type: step[0] });
        }, index * 3000);
    });

    setTimeout(function () { log("done: anything that did not match its 'expect' line is worth reporting"); }, STEPS.length * 3000 + 500);
}());
