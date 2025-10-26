function getTedgeTopicID(topic: string): string | undefined {
  return ["te", topic.split("/")[2].replace("_", "/"), "/"].join("/");
}

export { getTedgeTopicID };
