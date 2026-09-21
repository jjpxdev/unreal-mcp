import { describe, expect, it } from "vitest";
import { isSafeArg, safeArgString } from "./safe-arg.js";

describe("safe-arg", () => {
	it("accepts ordinary paths, platform, and config names", () => {
		for (const value of [
			"Win64",
			"Development",
			"Shipping",
			"C:\\Game\\MyProject",
			"/Game/Meshes",
			"-clean",
			"Project.Functional",
		]) {
			expect(isSafeArg(value)).toBe(true);
			expect(safeArgString.safeParse(value).success).toBe(true);
		}
	});

	it("rejects the shell metacharacters that break out of a spawn() argv element on Windows", () => {
		for (const value of [
			"C:\\Game & calc.exe & rem ",
			'Win64" & whoami & "',
			"foo | more",
			"foo ^& bar",
			"%COMSPEC%",
			"foo > out.txt",
			"foo < in.txt",
			"foo ! bang",
			"foo (paren)",
			"it's a test",
		]) {
			expect(isSafeArg(value)).toBe(false);
			expect(safeArgString.safeParse(value).success).toBe(false);
		}
	});
});
