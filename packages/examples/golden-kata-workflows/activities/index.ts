/**
 * The project's own activities, registered by name beside the connected
 * agents' (`<project>.<agent>.<Procedure>`); a workflow calls them through
 * `proxyActivities<typeof activities>`. A placeholder: replace it.
 */
export const activities = {
  async greet(name: string): Promise<string> {
    return `Hello, ${name}`;
  },
};
