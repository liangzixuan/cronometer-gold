const { withEntitlementsPlist, withInfoPlist } = require("expo/config-plugins");

/** This milestone schedules local reminders only; strip remote-push capabilities added by Expo. */
module.exports = function withLocalNotificationsOnly(config) {
  config = withEntitlementsPlist(config, (next) => {
    delete next.modResults["aps-environment"];
    return next;
  });
  return withInfoPlist(config, (next) => {
    const modes = next.modResults.UIBackgroundModes;
    if (Array.isArray(modes)) {
      const localModes = modes.filter((mode) => mode !== "remote-notification");
      if (localModes.length === 0) delete next.modResults.UIBackgroundModes;
      else next.modResults.UIBackgroundModes = localModes;
    }
    return next;
  });
};
