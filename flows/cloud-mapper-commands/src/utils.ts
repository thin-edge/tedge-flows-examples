function getTedgeTopicID(topic: string): string | undefined {
  const parts = topic.split("/");
  if (parts.length < 3) {
    return;
  }
  const cloudID = topic.split("/")[2].split("_");
  if (cloudID.length < 2) {
    return;
  }
  return ["te", ...cloudID, "/"].join("/");
}

export { getTedgeTopicID };
