const fs = require("fs");
const child_process = require("child_process");
const beautify = require("js-beautify").js;
const Diff = require("diff");
const yargs = require("yargs");
const path = require("path");
const chalk = require("chalk");
const brotli = require("brotli");


// C:\chromium\src\out\release\gen\content\browser\devtools\grit\devtools_resources_map.cc
// devtools://devtools/bundled/inspector_main/InspectorMain.js
// git checkout 39944955e0b5b571c2744b159af3244445215a7d~425 no visible errors

// Any part of any filename that should only be found in the chrome.dll exactly once, and should be found in the static array of
//  resource file names.
// C:\chromium\src\out\debug\gen\content\browser\devtools\grit\devtools_resources_map.cc
const resourcesArrayIndicator = "har_importer/";
const aliasTableId = Symbol("aliasTableId");


const syncDelay = 100;
const writePollInterval = 1000;

const message = chalk.hsl(0, 0, 96);
const info = chalk.hsl(200, 100, 75);
const warn = chalk.hsl(60, 100, 55);
const success = chalk.hsl(100, 100, 55);
const error = chalk.hsl(0, 100, 55);


// yarn start -c "C:/Users/quent/AppData/Local/Google/Chrome SxS/Application/chrome.exe" --remoteRepoUrl git@github.com:sliftist/devtools-frontend.git

/** @type {{ noAdminPrompt: boolean; optionsPath: string; resourcePaths: string[]; buildApplications: string[]; dryRun: boolean; devtoolsRepo: string; syncRepo: boolean; }} */
let argObj = yargs.command("")
    .option("noAdminPrompt", { description: "If true and we require administrative access we throw an error instead of prompting the user." })
    .option("buildApplications", { alias: "a", description: "Devtools applications to build.", type: "array", default: ["shell", "devtools_app"] })
    .option("resourcePaths", { alias: "p", description: "Path to resources.pak. On windows if this is not passed the MuiCache will be used to find chrome. On other systems this is required.", type: "array" })
    .option("chromePaths", { alias: "c", description: "Path to chrome.exe, an alternative to resources.pak.", type: "array" })
    .option("optionsPath", { description: "Argument for internal use only." })
    .option("closeOnWritable", { description: "Closes when the specified file at the specified path becomes writable. Used internally." })
    .option("skipFirstBuild", { })
    .option("onlyFirstChange", { alias: "q" })
    .option("dryRun", { alias: "d", description: "Don't write any files to the disk." })
    .option("devtoolsRepo", { description: "Path to repo contains devtools-frontend", default: "./devtools-frontend" })
    .option("syncRepo", { description: "If there isn't .git file at the folder given by devtoolsRepo, syncs a git repo in that folder", default: true, type: "boolean" })
    .option("remoteRepoUrl", { description: "Url of the remote devtools-frontend repo to sync, in relation to syncRepo", default: `git@github.com:ChromeDevTools/devtools-frontend.git` })
    .argv
;

if(argObj.optionsPath) {
    argObj = JSON.parse(fs.readFileSync(argObj.optionsPath));
}

if(argObj.closeOnWritable) {
    setInterval(() => {
        try {
            child_process.execSync(`powershell -Command "'test' > '${argObj.closeOnWritable}'"`, { stdio: "ignore" });
        } catch(e) {
            return;
        }
        console.log(`closeOnWritable path is writable, exiting process. ${argObj.closeOnWritable}`);
        process.exit();
    }, writePollInterval);
}

if(!fs.existsSync(argObj.devtoolsRepo)) {
    fs.mkdirSync(argObj.devtoolsRepo);
}
if(argObj.syncRepo) {
    let gitPath = argObj.devtoolsRepo + "/.git";
    if(!fs.existsSync(gitPath)) {
        child_process.execSync(`git clone ${argObj.remoteRepoUrl} ${argObj.devtoolsRepo}`, { stdio: "inherit" });
    }
}

const outputDirectory = argObj.devtoolsRepo + "/release/";
const inputDirectory = argObj.devtoolsRepo + "/front_end/";

/*
let dlls = [
    "C:/Users/quent/AppData/Local/Google/Chrome SxS/Application/82.0.4062.1/chrome.dll",
    "C:/Program Files (x86)/Google/Chrome/Application/79.0.3945.130/chrome.dll"
];
console.log();
for(let dll of dlls) {
    console.log(dll);
    let idLookup = parseStringLookupAround(fs.readFileSync(dll), resourcesArrayIndicator);
    let pakPath = dll.replace(/\\/g, "/").split("/").slice(0, -1).join("/") + "/" + "resources.pak";
    console.log(pakPath);
    let pakFile = fs.readFileSync(pakPath);
    let pak = parseResourcePak(pakFile);

    let lookup = Object.create(null);

    for(let name in idLookup) {
        let id = idLookup[name];
        let buffer = pak[id];
        if(!buffer) {
            //console.warn(`No id pak for id ${id}, ${name}`);
            continue;
        }
        lookup[name] = buffer;
    }

    console.log(Object.keys(lookup).filter(x => x.includes("sources")).slice(0, 10));

    console.log(decompressIfNeeded(lookup["shell.js"]).toString("ascii").length);

    console.log();
}
*/
//parseStringLookupAround(fs.readFileSync("C:/Program Files (x86)/Google/Chrome/Application/79.0.3945.130/chrome.dll"), resourcesArrayIndicator);

startWatch(getExePaths());

function readNullTerminatedString(
    /** @type {Buffer} */ buffer,
    /** @type {number} */ posStart
) {
    let text = "";
    let pos = posStart;
    while(buffer[pos] !== 0) {
        text += String.fromCharCode(buffer[pos++]);
    }
    return text;
}

/** @return {{ [fileName: string]: number }} */
function parseStringLookupAround(
    /** @type {Buffer} */ buffer,
    /** @type {number} */ text
) {
    let pos = buffer.toString("ascii").indexOf(text);

    // There are many c strings, followed by...
    //  Some kind of array, of something like addresses and indexes. The first address and index seem mostly random,
    //  but the offsets make sense (the indexes increase by 1, the addresses start at the start of strings).
    // ALSO! There is NULL padding after the end of the c strings, making the table aligned.
    //  The table might be 16 bytes per entry, or 8 bytes per entry, and is aligned to the size of the entries.

    // Therefore, if we start in the middle of the c strings, we can keep looking until we find incrementing entry indexes,
    //  at which point we are likely in the entry table.
    // Then we can parse the entire entry table.
    // Before the entry table will be NULLs, and then the end of the last c string (hopefully the last C string doesn't have NULLs in the
    //  string itself, which may be possible if they aren't actually c strings...).
    // We can find the size of the string lookup with the difference in the first and last addresses in the entry table.
    // From the size we can find the start of the c string table.
    // Then by inferring the distance between addresses, and using the end of the last c string, we can find the sizes
    //  and contents of all the c strings.


    // TODO: We make a lot of assumptions that ids will be in order, and increasing. Instead, we should somehow use the differences in addresses to
    //  line up with the string positionings. This would be a lot more complicated (there are multiple possible c string table starts) but
    //  a lot more robust (as there is no reason the ids to be offset from indexes, except for the fact that they are generated and happen to always be in order
    //  and sequential)

    let offsetCount = 0;

    //todonext;
    // Use generators

    function parseEntry(pos, intSize) {
        if(pos + intSize * 2 > buffer.length) return null;
        return {
            address: buffer.readUInt32LE(pos),
            id: buffer.readUInt32LE(pos + intSize),
        }
    }

    function* createEntryTester(intSize) {
        let curPos = pos - pos % (intSize * 2);
        let lastIndex = 0;
        let consecutiveIndexes = 0;
        while(true) {
            let entry = parseEntry(curPos, intSize);
            if(!entry) break;
            
            let index = entry.id;
            if(index - lastIndex === 1) {
                consecutiveIndexes++;

                if(consecutiveIndexes >= 10) {
                    yield curPos;
                }
            } else {
                consecutiveIndexes = 0;
            }
            lastIndex = index;

            curPos += intSize * 2;
            yield 0;
        }
    }

    function getIntSize() {
        let generators = [4, 8].map(intSize => {
            return {
                intSize,
                generator: createEntryTester(intSize),
            };
        });

        while(true) {
            let tested = false;
            
            for(let { intSize, generator } of generators) {
                let val = generator.next();
                if(!val.done) {
                    tested = true;
                    if(val.value !== 0) {
                        pos = val.value;
                        return intSize;
                    }
                }
            }
    
            if(!tested) {
                throw new Error(`Cannot find entry table for lookup.`);
            }
        }
    }
    
    let intSize = getIntSize();
    console.log({intSize});
    
    // Go to the start of the entry table
    while(true) {
        if(parseEntry(pos - intSize * 2, intSize).id + 1 !== parseEntry(pos, intSize).id) {
            break;
        }
        pos -= intSize * 2;
    }

    let startOfEntryTable = pos;

    // Skip any extra alignment NULL characters to find the end of the last string
    while(buffer[pos - 1] === 0) pos--;
    pos++;

    
    let endOfLastString = pos;
    pos -= 2;
    while(buffer[pos] !== 0) pos--;
    pos++;
    let startOfLastString = pos;

    console.log({endOfLastString: endOfLastString.toString(16)});

    // Parse the entry table
    let entryTable = [];
    pos = startOfEntryTable;
    while(true) {
        let entry = parseEntry(pos, intSize);
        if(!entry) break;
        if(entryTable.length > 0 && entry.id !== entryTable[entryTable.length - 1].id + 1) break;
        entryTable.push(entry);
        pos += intSize * 2;
    }

    console.log("entryTable.length", entryTable.length);

    // We now the distance between the starts of the first and last string (the difference in addreses, so we can find the start of the strings)
    let startOfFirstString = startOfLastString - (entryTable.slice(-1)[0].address - entryTable[0].address);

    console.log({startOfFirstString: startOfFirstString.toString(16)});


    let idLookup = Object.create(null);

    let addressOffet = startOfFirstString - entryTable[0].address;

    for(let entry of entryTable) {
        let pos = entry.address + addressOffet;
        let str = "";
        while(buffer[pos] !== 0) {
            str += String.fromCharCode(buffer[pos]);
            pos++;
        }
        idLookup[str.toLowerCase()] = entry.id;
    }

    return idLookup;
}


/** @return {{ [id: number]: Buffer }&{ [aliasTableId]: Buffer }} */
function parseResourcePak(
    /** @type {Buffer} */ buffer
) {
    function read(
        /** @type {number} */
        offset,
        /** @type {number} */
        size
    ) {
        return buffer.slice(offset, offset + size);
    }

    // https://github.com/chromium/chromium/blob/a94478c07af27f2a1ef6c0c85ff0eb9896fe3146/ui/base/resource/data_pack.cc
    // https://stackoverflow.com/questions/10633357/how-to-unpack-resources-pak-from-google-chrome
    let version = buffer.readUInt32LE(0);
    if(version !== 5) {
        console.error(`Unexpected resource.pak version of ${version}. Expected 5. Parsing may fail, and the file may be corrupted (but it'll probably be fine).`);
    }
    let encoding = buffer[4];
    // (3 bytes padding)
    let resourceCount = buffer.readUInt16LE(8);
    let aliasCount = buffer.readUInt16LE(10);

    let headerSize = 12;

    /** @type {{ resourceId: number; resourceOffset: number; size: number; }[]} */
    let resourceList = [];

    // + 1, "There's an extra entry after the last item which gives us the length of the last item."
    for(let i = 0; i < resourceCount + 1; i++) {
        let resourceId = buffer.readUInt16LE(headerSize + i * 6);
        let resourceOffset = buffer.readUInt32LE(headerSize + i * 6 + 2);
        if(resourceOffset > buffer.length) {
            throw new Error(`Resource has an offset beyond the end of the file. Resource at index ${i} (byte offset ${headerSize + i * 6}), offset ${resourceOffset}, length of the file ${buffer.length}.`);
        }
        let res = { resourceId, resourceOffset, size: 0 };
        resourceList.push(res);
    }

    for(let i = 0; i < resourceCount; i++) {
        resourceList[i].size = resourceList[i + 1].resourceOffset - resourceList[i].resourceOffset;
    }

    /** @type {{ [id: number]: Buffer }&{ [aliasTableId]: Buffer }} */
    let resourceLookup = Object.create(null);
    for(let resourceObj of resourceList) {
        let { resourceId, resourceOffset, size } = resourceObj;
        // Skip the extra source that is just used for the last size
        if(resourceId === 0) continue;
        resourceLookup[resourceId] = buffer.slice(resourceOffset, resourceOffset + size);
    }

    let aliasPos = headerSize + (resourceCount + 1) * 6;
    let aliasTable = buffer.slice(aliasPos, aliasPos + aliasCount * 4);

    resourceLookup[aliasTableId] = aliasTable;

    return resourceLookup;
}

/** @return {Buffer} */
function generateResourcePak(
    /** @type {{ [id: number]: Buffer }&{ [aliasTableId]: Buffer }} */ resourceLookup
) {
    let version = 5;
    let encoding = 1;

    let aliasTable = resourceLookup[aliasTableId];

    let resourceCount = Object.keys(resourceLookup).length;
    
    let header = Buffer.alloc(12);
    header.writeUInt32LE(version, 0);
    header.writeUInt32LE(encoding, 4);
    header.writeUInt16LE(resourceCount, 8);
    header.writeUInt16LE(aliasTable.length / 4, 10);

    let resourceTable = Buffer.alloc((resourceCount + 1) * 6);
    let index = 0;
    let offset = header.length + resourceTable.length + aliasTable.length;
    for(let idStr in resourceLookup) {
        let id = +idStr;

        resourceTable.writeUInt16LE(id, index * 6);
        resourceTable.writeUInt32LE(offset, index * 6 + 2);
        offset += resourceLookup[idStr].length;
        index++;
    }

    // Last entry for the length of the last resource
    resourceTable.writeUInt16LE(0, index * 6);
    resourceTable.writeUInt32LE(offset, index * 6 + 2);

    let resourceValues = Buffer.concat(Object.values(resourceLookup));

    return Buffer.concat([header, resourceTable, aliasTable, resourceValues]);
}

/** @return {Buffer} */
function decompressIfNeeded(
    /** @type {Buffer} */
    buffer
) {
    if(buffer.length <= 8) return buffer;
    if(buffer[0] === 30 && buffer[1] === 155) {
        // The next 2 bytes are also part of the length, but... they probably won't be needed...
        let length = buffer.readUInt32LE(2);
        return Buffer.from(brotli.decompress(buffer.slice(8), length));
    }
    return buffer;
}

function build() {
    for(let buildApplication of argObj.buildApplications) {
        let buildCommand = `py ${inputDirectory}/../scripts/build/build_release_applications.py ${buildApplication} --input_path ${inputDirectory} --output_path ${outputDirectory}`;
        console.log(message(buildCommand));
        child_process.execSync(buildCommand);
    }
}



/** @return {{ [moduleFileName: string]: { [sourceFileName: string]: true }}} */
function getModuleFiles() {
    function getModuleFilePaths(moduleName) {
        let moduleFilePath = inputDirectory + moduleName + "/module.json";
        let jsonContents = JSON.parse(fs.readFileSync(moduleFilePath));

        let files = (
            (jsonContents.modules || [])
            .concat(jsonContents.scripts || [])
            .concat(jsonContents.resources || [])
        );

        return files.map(fileName => inputDirectory + moduleName + "/" + fileName);
    }


    /** @type {{ [moduleFileName: string]: { [sourceFileName: string]: true }}} */
    let moduleFiles = Object.create(null);

    let jsonFiles = fs.readdirSync(inputDirectory).filter(x => x.endsWith(".json"));
    for(let rootJsonFileName of jsonFiles) {
        let jsonContents = JSON.parse(fs.readFileSync(inputDirectory + rootJsonFileName));

        let rootModuleName = rootJsonFileName.slice(0, -5) + ".js";
        let rootFilePath = outputDirectory + rootModuleName;
        moduleFiles[rootFilePath] = moduleFiles[rootFilePath] || Object.create(null);

        for(let moduleObj of jsonContents.modules) {
            //if(moduleObj.type === "remote") continue;

            // All module.json files can impact the root bundle (due to extensions?)
            moduleFiles[rootFilePath][inputDirectory + moduleObj.name + "/module.json"] = true;

            let files = getModuleFilePaths(moduleObj.name);

            let moduleFileName = (
                moduleObj.type === "autostart"
                ? rootModuleName
                : moduleObj.name + "/" + moduleObj.name + "_module.js"
            );
            moduleFileName = outputDirectory + moduleFileName;

            moduleFiles[moduleFileName] = moduleFiles[moduleFileName] || Object.create(null);

            for(let filePath of files) {
                moduleFiles[moduleFileName][filePath] = true;
            }
        }
    }

    return moduleFiles;
}

function getResourcePakFromExePath(exePath) {
    let exeFolder = exePath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");

    // So... it almost seems like there can be multiple versions, but... the version folder is under chrome.exe,
    //  so can/does anyone run multiple version folders? If so... we need to iterate over all of them, expanding one
    //  chrome.exe to multiple choices.
    let versionFolders = fs
        .readdirSync(exeFolder)
        .filter(x => x.split(".").length === 4)
    ;
    for(let versionFolder of versionFolders) {
        let path = exeFolder + "/" + versionFolder + "/resources.pak";
        if(fs.existsSync(path)) {
            return path;
        }
    };

    return undefined;
}
function getExePaths() {
    if(argObj.chromePaths) {
        return argObj.chromePaths;
    }
    if(process.platform === "win32") {
        // Possible other registry locations to search:
        //  Computer\HKEY_LOCAL_MACHINE\SOFTWARE\Clients\StartMenuInternet\Google Chrome\shell\open\command
        //  HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FeatureUsage\AppLaunch
        //  Computer\HKEY_CURRENT_USER\Software

        let executables = JSON.parse(child_process.execSync(`powershell "Get-Item -path 'HKCU:/Software/Classes/Local Settings/Software/Microsoft/Windows/Shell/MuiCache' | Select-Object -ExpandProperty Property | ConvertTo-Json"`).toString("utf8"));
        executables = executables.filter(x => x.endsWith("chrome.exe.FriendlyAppName"));
        executables = executables.map(x => x.slice(0, -".FriendlyAppName".length));
        // If you build chrome yourself you can easily have chrome executables (that are actually chrome), with no resources.paks (because it will
        //  serve from the disk in an unbundled state instead).
        executables = executables.filter(x => fs.existsSync(getResourcePakFromExePath(x)));
        
        if(executables.length === 0) {
            executables.push(JSON.parse(child_process.execSync(`powershell "Get-ItemProperty -path 'HKLM:\\SOFTWARE\\Clients\\StartMenuInternet\\Google Chrome\\shell\\open\\command' | Select-Object -ExpandProperty \\"(default)\\" | ConvertTo-Json"`).toString("utf8")).slice(1, -1));
        }

        return executables;
    }

    // TODO: Also support "where chrome" to find chromes.

    throw new Error(`On non windows systems "--resourcePaths" must be used to configure path(s) to resources.pak.`);
}

function requiresAdminAccess(
    /** @type {string} */
    resourcePakFile
) {
    if(argObj.dryRun) return false;
    try {
        fs.writeFileSync(resourcePakFile + ".test.temp", "");
        fs.unlinkSync(resourcePakFile + ".test.temp");
        return false;
    } catch(e) {
        // We can't copy the file!? We must not be an administrator, so elevator our privileges
        if(argObj.noAdminPrompt) {
            throw e;
        }

        return true;
    }
}

function group() {
    console.group();
    console.group();
}
function groupEnd() {
    console.groupEnd();
    console.groupEnd();
}


function startWatch(
    /** @type {string[]} */
    exePaths
) {
    let resourceFiles = [];
    if(argObj.resourcePaths) {
        resourceFiles = argObj.resourcePaths;
    } else {
        let exePathsOriginal = exePaths.slice();
        for(let i = exePaths.length - 1; i >= 0; i--) {
            let exePath = exePaths[i];
            let resourceFile = getResourcePakFromExePath(exePath);
            if(!resourceFile) {
                exePaths.splice(i, 1);
            } else {
                resourceFiles.unshift(resourceFile);
            }
        }
        if(resourceFiles.length === 0) {
            console.error(error(`Cannot find resource paks for any chrome executables. Looked for paths nears the executable paths [${exePathsOriginal.join(", ")}]`));
            process.exit();
        }
    }

    if(!argObj.dryRun) {
        if(!fs.existsSync(outputDirectory)) {
            fs.mkdirSync(outputDirectory);
        }
    }

    if(!argObj.dryRun) {
        // TODO: Don't hardcode these to empty, actually figure out how to populate them.
        //todonext
        // Do this next, as without populating these our shell.js patch will be broken, and shell.js has
        //  most files...
        //  Actually... let's do it by patching certain files by preserving specific lines, as I think the bulk of
        //  these files go into just 1 or two lines. So... 
        if(!fs.existsSync(outputDirectory + "InspectorBackendCommands.js")) {
            fs.writeFileSync(outputDirectory + "InspectorBackendCommands.js", "");
        }
        if(!fs.existsSync(outputDirectory + "SupportedCSSProperties.js")) {
            fs.writeFileSync(outputDirectory + "SupportedCSSProperties.js", "");
        }
        if(!fs.existsSync(outputDirectory + "accessibility")) {
            fs.mkdirSync(outputDirectory + "accessibility");
        }
        if(!fs.existsSync(outputDirectory + "accessibility/ARIAProperties.js")) {
            fs.writeFileSync(outputDirectory + "accessibility/ARIAProperties.js", "");
        }
    }

    for(let resourceFile of resourceFiles) {
        if(requiresAdminAccess(resourceFile)) {
            console.log(success(`Running again as subcommand to gain administrative access to ${resourceFile}`));
            rerunAsAdmin();
            return;
        }
    }

   
    let dirs = fs.readdirSync(inputDirectory, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => x.name);
    /** @type {{[filename: string]: true}} */
    let pendingChanges = {};
    let isPending = false;
    /** @type {{ [key: string]: any }} */
    let pendingLockedPakChanges = {};

    dirs.push("main");

    if(!argObj.skipFirstBuild) {
        try {
            runTimed(build);
        } catch(e) {
            console.error(error(e.stack));
            console.error(error(`\nFIRST BUILD FAILED`));
        }
    }
    triggerInner();

    for(let dir of dirs) {
        fs.watch(`${inputDirectory}/${dir}`, { recursive: true }, (eventType, filename) => {
            if(filename === "_patch" || filename.endsWith(".mutated")) return;
            if(!argObj.dryRun) {
                fs.writeFileSync(`${inputDirectory}/${dir}/${filename}.mutated`, "");
            }
            trigger(filename);
        });
    }

    function trigger(filename) {
        pendingChanges[filename] = true;
        if(!isPending) {
            isPending = true;
            setTimeout(triggerInner, syncDelay);
        }
    }
    function triggerInner() {
        console.log();
        isPending = false;
        if(Object.keys(pendingChanges).length > 0) {
            console.log(message(`Triggering rebuild because of changes in ${Object.keys(pendingChanges).join(", ")}`));
            pendingChanges = {};
            runTimed(build);
        }
        for(let i = 0; i < resourceFiles.length; i++) {
            let resourcePakFile = resourceFiles[i];
            const checkForMove = () => {
                if(!argObj.resourcePaths) {
                    let newResourcePakFile = getResourcePakFromExePath(exePaths[i]);
                    if(newResourcePakFile !== resourcePakFile) {
                        console.log(info(`Resource pak moved, updating target`));
                        resourcePakFile = newResourcePakFile;
                        resourceFiles[i] = newResourcePakFile;
                        return true;
                    }
                }
            };
            console.log(message(`Parsing file (${i + 1}/${resourceFiles.length}) ${resourcePakFile}`));
            group();
            runTimed(function Parse() {

                checkForMove();

                if(!fs.existsSync(resourcePakFile + ".backup")) {
                    fs.copyFileSync(resourcePakFile, resourcePakFile + ".backup");
                }

                let newPak;
                try {
                    // Generate from the backup, so we aren't just combining with previous changes.
                    newPak = generateNewPak(resourcePakFile + ".backup");
                } catch(e) {
                    console.log(error(`Error when generating new resource pak ${e.stack}`));
                    return;
                }

                try {
                    if(!argObj.dryRun) {
                        fs.writeFileSync(resourcePakFile + ".temp", newPak);
                    }
                } catch(e) {
                    if(checkForMove()) {
                        i--;
                        return;
                    } else {
                        return;
                    }
                }
                // Write then rename, as rename is atomic, and we don't want to ever corrupt resources.pak
                // ALSO... I believe the fact that we do both of these synchronously, means we shouldn't be able to race ourself on this. Which...
                //  means we can race with renameSync and not risk renaming a file that hasn't finished writing (although, that might not be a problem anyway,
                //  I'm not sure if nodejs will rename a file while it is writing to it).
                try {
                    if(!argObj.dryRun) {
                        fs.renameSync(resourcePakFile + ".temp", resourcePakFile);
                    }
                    console.log(success(`${argObj.dryRun ? "(dryrun) " : ""}Updated file ${resourcePakFile}`));
                } catch(e) {
                    // TODO: We can check who is locking the file... at least on windows (with handle.exe). So we should probably at least tell
                    //  the user which process is locking it.
                    if(!(resourcePakFile in pendingLockedPakChanges)) {
                        console.error(warn(`Error when writing to resources.pak. Assuming the file is locked by a running version of chrome. A periodically check of the file will run in the background and apply the changes when it is writable.`));
                        group();
                        console.error(warn(`Error: ${e.message}`));
                        groupEnd();
                        
                        pendingLockedPakChanges[resourcePakFile] = setInterval(() => {
                            try {
                                if(!argObj.dryRun) {
                                    fs.renameSync(resourcePakFile + ".temp", resourcePakFile);
                                }
                            } catch(e) {
                                return;
                            }
                            console.log(success(`${argObj.dryRun ? "(dryrun) " : ""}Updated file (delayed) ${resourcePakFile}`));
                            clearInterval(pendingLockedPakChanges[resourcePakFile]);
                            delete pendingLockedPakChanges[resourcePakFile];
                        }, writePollInterval);
                    } else {
                        console.error(warn(`Still erroring when writing to resources.pak.`));
                    }
                }

                if(argObj.onlyFirstChange) {
                    process.exit();
                }
            });
            groupEnd();
            console.log();
        }
    }

    function generateNewPak(/** @type {string} */ resourcePakFile) {
        let libraryFilePath = resourcePakFile.split("/").slice(0, -1).join("/") + "/chrome.dll";
        let libraryFile = fs.readFileSync(libraryFilePath);


        let idLookup = parseStringLookupAround(
            libraryFile,
            resourcesArrayIndicator
        );

        let resourcePak = fs.readFileSync(resourcePakFile);

        let noFilesChanged = true;

        let resourceLookup = parseResourcePak(resourcePak);
        
        let moduleFiles = getModuleFiles();

        let totalInDll = 0;
        let totalFilesFoundOnDisk = 0;
        for(let moduleFileName in moduleFiles) {
            let files = moduleFiles[moduleFileName];
            for(let fileName in files) {
                totalInDll++;
                if(fs.existsSync(fileName)) {
                    totalFilesFoundOnDisk++;
                }
            }
        }

        let matchFactor = totalFilesFoundOnDisk / totalInDll;

        console.log(info(`${totalFilesFoundOnDisk} / ${totalInDll} (${(matchFactor * 100).toFixed(1)}%) files from dll matched in repo.`));



        function changeId(id, newBuffer) {
            let oldBufferBase = resourceLookup[id];
            let oldBuffer = decompressIfNeeded(oldBufferBase);

            resourceLookup[id] = newBuffer;
            console.log(info(`    Length change from ${oldBuffer.length} (${oldBuffer.length}) to ${newBuffer.length}`));
        }

        for(let moduleFileName in moduleFiles) {
            let files = moduleFiles[moduleFileName];

            let filePaths = Object.keys(files).filter(filePath => fs.existsSync(filePath + ".mutated"));

            if(filePaths.length > 0) {
                noFilesChanged = false;

                let fileName = moduleFileName.slice(outputDirectory.length).toLowerCase();
                let id = idLookup[fileName];

                let newBuffer = fs.readFileSync(moduleFileName);

                console.log(info(`Changed ${moduleFileName} due to \n${filePaths.map(x => "    " + "    " + x + ".mutated").join("\n")}`));
                changeId(id, newBuffer);

                for(let filePath of filePaths) {
                    let rawPath = filePath.slice(inputDirectory.length).toLowerCase();
                    if(rawPath in idLookup) {
                        console.log(info(`Changed raw file ${filePath}`));
                        let id = idLookup[rawPath];
                        changeId(id, fs.readFileSync(filePath));
                    }
                }
            }
        }

        //console.log(Object.keys(moduleFiles['./devtools-frontend/release/shell.js']).filter(x => x.includes(".json")));

        let newResourcePak = generateResourcePak(resourceLookup);

        if(noFilesChanged) {
            console.log(warn(`No files changed, changed files have to be touched when the script is running, so they can be detected`));
        }

        return newResourcePak;
    }
}

function rerunAsAdmin() {

    var logPath = path.resolve("./log.txt.temp").replace(/\\/g, "/");
    var optionsPath = path.resolve("./options.txt.temp").replace(/\\/g, "/");
    var batchPath = path.resolve("./batch.temp.bat").replace(/\\/g, "/");

    var lockPath = path.resolve("./lock.temp").replace(/\\/g, "/");
    fs.openSync(lockPath, "w");

    fs.writeFileSync(logPath, "");

    argObj.noAdminPrompt = true;
    if(process.platform === "win32") {
        argObj.closeOnWritable = lockPath;
    }

    fs.writeFileSync(optionsPath, JSON.stringify(argObj));

    let batchRun = `cd ${path.resolve(".")}\n${process.argv[0]} ${process.argv[1]} --optionsPath ${optionsPath} >> ${logPath} 2>&1`;

    fs.writeFileSync(batchPath, batchRun);
    //fs.writeSync(tmpBatch.fd, );

    let intervalId = 0;
    child_process.exec(`powershell Start-Process ${batchPath} -Verb runas -Wait`, { windowsHide: true }, (error, stdout, stderr) => {
        console.log({error});
        clearInterval(intervalId);
        fs.unlinkSync(logPath);
        fs.unlinkSync(optionsPath);
        fs.unlinkSync(batchPath);
    });

    let logPos = 0;
    intervalId = setInterval(() => {
        let info = fs.statSync(logPath);
        let size = info.size;
        if(size === logPos) {
            return;
        }

        try {
            // NodeJS does support file sharing permissions? So was can't open the file, or else the spawned process won't
            //  be able to write to it. But seriously, there has to be a better way than this...
            let text = fs.readFileSync(logPath);
            
            text = text.slice(logPos);
            logPos += text.length;

            process.stdout.write(text.toString("utf8"));
        }
        catch(e) {
            console.log("error", e);
        }
    }, 100);
}

function runTimed(fnc) {
    let time = Date.now();
    fnc();
    time = Date.now() - time;
    console.log(`${fnc.name} finished in ${time}ms`);
}