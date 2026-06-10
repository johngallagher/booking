export const gymSchedule = {
  // Include sessions ending at or before this time (early morning window)
  morningEndBy: "09:30",
  // Include sessions starting at or after this time (evening window)
  eveningStartFrom: "17:00",
  activeMembership: "boxing" as "boxing" | "sgpt",
  memberships: {
    boxing: {
      sessions: ["Smash HIIT", "Bags & Pads", "Boxing Fundamentals", "10 ROUNDS", "BOX-TEC"],
    },
    sgpt: {
      extraSessions: ["SGPT"],
    },
  },
};

export const tennisSchedule = {
  sessionName: "Indoor Tennis",
};

// Workspace user the service account impersonates via domain-wide delegation.
// Events are created as this user, so they can invite external attendees
// (plain service accounts are forbidden from adding attendees).
export const workspaceUser = "john@synapticmishap.co.uk";

// Service accounts don't auto-populate calendarList with shared calendars,
// so we reference the "Exercise" calendar directly by its known ID.
export const exerciseCalendarId =
  "c6a0051835d914274ad7ea435c2237117b0f77f537434f7cf036fee4cdf903a8@group.calendar.google.com";
