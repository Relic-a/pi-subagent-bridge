import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export function discoverRuntime(env = process.env) {
    const nodeExecutable = fs.realpathSync(process.execPath);
    const requestedPi = env.PI_EXECUTABLE?.trim() || "pi";
    const pi = findExecutableLocation(requestedPi, env.PATH ?? "", env);
    return {
        nodeExecutable,
        piExecutable: pi?.executable ?? requestedPi,
        piFound: pi !== undefined,
        // Pi's launcher can use `#!/usr/bin/env node`. Put its selected bin
        // directory first when discovery needed a fallback so that launcher keeps
        // using the Node installation that supplied Pi.
        env: pi ? withExecutableDirectory(env, pi.directory) : { ...env },
    };
}
export function findExecutable(command, searchPath = process.env.PATH ?? "", env = process.env) {
    return findExecutableLocation(command, searchPath, env)?.executable;
}
function findExecutableLocation(command, searchPath, env) {
    const hasPath = command.includes(path.sep) || (path.sep === "\\" && command.includes("/"));
    if (hasPath) {
        const candidate = path.resolve(command);
        const executable = executablePath(candidate, env);
        return executable
            ? { executable, directory: path.dirname(candidate) }
            : undefined;
    }
    for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
        const found = executablePath(path.join(directory, command), env);
        if (found)
            return { executable: found, directory };
    }
    // GUI-launched apps often receive a minimal PATH. These cover the usual
    // user-local and system install locations without invoking a login shell.
    const home = env.HOME ?? os.homedir();
    const fallbackDirectories = [
        path.join(home, ".local", "bin"),
        path.join(home, ".npm-global", "bin"),
        path.dirname(process.execPath),
        path.join(home, ".volta", "bin"),
        path.join(home, ".local", "share", "pnpm"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
    ];
    for (const directory of fallbackDirectories) {
        const found = executablePath(path.join(directory, command), env);
        if (found)
            return { executable: found, directory };
    }
    return undefined;
}
function withExecutableDirectory(env, directory) {
    const entries = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
    if (entries.includes(directory))
        return { ...env };
    return { ...env, PATH: [directory, ...entries].join(path.delimiter) };
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
