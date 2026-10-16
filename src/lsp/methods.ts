// Names shared by the server and the clients. The custom methods and the
// virtual document scheme are part of the protocol between them.

/** Request: the generated TypeScript text of one `.eff` module. */
export const GENERATED_TYPESCRIPT_METHOD = "effective/generatedTypeScript";

/** Notification: the generated text or the stale flag of a subscribed module changed. */
export const GENERATED_CHANGED_METHOD = "effective/generatedChanged";

/** Request: revision, query counts, and memory use for the measurements. */
export const STATS_METHOD = "effective/stats";

/** The URI scheme of the virtual document that shows generated TypeScript. */
export const GENERATED_SCHEME = "effective-generated";
