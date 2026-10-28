import type { OpenCodeClient } from "@opencode/client/promise"

/** The signed-in member's organization shared space, or undefined without an organization account. */
export async function sharedSpace(client: OpenCodeClient) {
  const session = await client["server.auth"].session().catch(() => undefined)

  if (!session?.organizationDirectory) return

  return {
    directory: `${session.organizationDirectory.replace(/[\\/]+$/, "")}/公共空间`,
    /** Members change only this subfolder of the shared space. */
    own: session.employeeID,
  }
}
