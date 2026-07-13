import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export function discoverRuntime(env = process.env) {
    const nodeExecutable = fs.realpathSync(process.execPath);
    const requestedPi = env.PI_EXECUTABLE?.trim() || "pi";
    const resolvedPi = findExecutable(requestedPi, env.PATH ?? "", env);
    return {
        nodeExecutable,
        piExecutable: resolvedPi ?? requestedPi,
        piFound: resolvedPi !== undefined,
        // Pi's launcher can select its own Node runtime with `#!/usr/bin/env
        // node`. Keep the environment that located Pi intact; the Node process
        // hosting this MCP server is not necessarily compatible with Pi.
        env: { ...env },
    };
}
export function findExecutable(command, searchPath = process.env.PATH ?? "", env = process.env) {
    const hasPath = command.includes(path.sep) || (path.sep === "\\" && command.includes("/"));
    if (hasPath)
        return executablePath(path.resolve(command), env);
    for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
        const found = executablePath(path.join(directory, command), env);
        if (found)
            return found;
    }
    // GUI-launched apps often receive a minimal PATH. These cover the usual
    // user-local and system install locations without invoking a login shell.
    const home = env.HOME ?? os.homedir();
    const fallbackDirectories = [
        path.join(home, ".local", "bin"),
        path.join(home, ".npm-global", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
    ];
    for (const directory of fallbackDirectories) {
        const found = executablePath(path.join(directory, command), env);
        if (found)
            return found;
    }
    return undefined;
}
function executablePath(candidate, env) {
    const extensions = process.platform === "win32"
        ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
        : [""];
    const candidates = path.extname(candidate)
        ? [candidate]
        : extensions.map((extension) => `${candidate}${extension.toLowerCase()}`);
    for (const value of candidates) {
        try {
            fs.accessSync(value, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
            if (fs.statSync(value).isFile())
                return fs.realpathSync(value);
        }
        catch {
            // Keep searching.
        }
    }
    return undefined;
}
