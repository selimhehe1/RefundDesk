export function assertDatabaseMutationAllowed(nodeEnvironment, canonicalReleaseActive) {
  if (nodeEnvironment === "production" && !canonicalReleaseActive) {
    throw new Error("PRODUCTION_DATABASE_MUTATION_REQUIRES_RELEASE_PREPARE");
  }
}
