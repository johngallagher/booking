export const gymSchedule = {
  // Include sessions ending at or before this time (early morning window)
  morningEndBy: "09:00",
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
