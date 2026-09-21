import { z } from "zod";

/**
 * Characters cmd.exe treats as command separators/operators or expansion
 * triggers (& | ^ < > ( ) ! " ' % plus CR) that let a single spawn() argv
 * element break out into additional commands on Windows — this holds even
 * without shell:true, since Node still routes .bat/.cmd invocation through
 * cmd.exe internally. Anything forwarded into SubprocessRunner's argv must
 * be validated against this before it reaches spawn().
 */
const UNSAFE_ARG_PATTERN = /[&|^<>()!"'%\r]/;

export function isSafeArg(value: string): boolean {
	return !UNSAFE_ARG_PATTERN.test(value);
}

/**
 * Zod schema for a free-text string that may be forwarded into
 * SubprocessRunner (runUAT/runUBT/runCommandlet) argv. Rejects shell
 * metacharacters at the tool-call boundary, independent of whatever
 * spawn() itself does or doesn't escape.
 */
export const safeArgString = z.string().refine(isSafeArg, {
	message: 'must not contain shell metacharacters: & | ^ < > ( ) ! " \' % or a carriage return',
});
