/**
 * Invalid fixture: `cmd` is a string rather than an argv array.
 *
 * `validateUserConfig` rejects it with a "Did you mean [...]?" message, which
 * `loadUserConfig` must surface as a `ConfigLoadError` instead of throwing.
 */
export default {
	servers: {
		pyright: {
			cmd: "pyright-langserver",
		},
	},
};
