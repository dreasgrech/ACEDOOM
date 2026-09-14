/*
 * guisound3.js -- which livery-editor GUI event type plays which sample? Dev console:
 *
 *     .run guisound3
 *
 * Discovery round 2. The patched gui.bank holds seven unmistakable DOOM sounds in the seven
 * samples the livery-editor event plays:
 *     pistol shot        = paint spray gun          door sliding open  = can spray paint
 *     shotgun boom       = spray paint 07           barrel explosion   = paper wrap
 *     player pain grunt  = ext gun install          zombie death yell  = ext gun remove
 *     zombie growl       = pneumatic wrench
 * The eight types are requested three seconds apart; the console shows the number and type
 * before each. Note the sound for each number: pistol, shotgun, door, explosion, grunt, yell,
 * growl or silent.
 */
(function () {
    const log = function (text) { console.log("[guisound3] " + text); };
    const NAME = "UIAudioRequestAudioEvent";
    const TYPES = ["GUI_PAINT_APPLY", "GUI_PAINT_REMOVE", "GUI_STICKER_APPLY", "GUI_STICKER_REMOVE",
        "GUI_PART_APPLY", "GUI_PART_REMOVE", "GUI_WHEEL_APPLY", "GUI_WHEEL_REMOVE"];

    if (typeof engine === "undefined" || !engine.trigger) {
        log("no engine on this page");
        return;
    }

    TYPES.forEach(function (type, index) {
        setTimeout(function () {
            log((index + 1) + " of 8: " + type + "  -> pistol / shotgun / door / explosion / grunt / yell / growl / silent ?");
            engine.trigger("OnUICommand", NAME, { __Type: NAME, type: type });
        }, index * 3000);
    });

    setTimeout(function () { log("done: report the eight answers in order"); }, TYPES.length * 3000 + 500);
}());
