"use strict";

import express from 'express';
import http from 'http';
import https from 'https';
import expressWs from 'express-ws';
import {
    WebUSB
} from 'usb';
import yargs from 'yargs';
import fs from 'fs';
import {
    hideBin
} from 'yargs/helpers';
import {
    sanitizeFullWidthTitle,
    sanitizeHalfWidthTitle
} from 'netmd-js/dist/utils.js';
import {
    MDTrack,
    getDeviceStatus,
    Encoding,
    listContent,
    openNewDevice,
    renameDisc,
    DevicesIds,
    rewriteDiscGroups,
    prepareDownload,
    EKBOpenSource,
    MDSession,
    Wireformat
} from 'netmd-js';
import {
    Mutex
} from 'async-mutex';

// Compatibility methods. Do NOT use these unless absolutely necessary!!
export function convertDiscToWMD(source){
    return {
        ...source,
        left: Math.ceil(source.left / 512),
        total: Math.ceil(source.total / 512),
        groups: source.groups.map(convertGroupToWMD),
    };
}

export function convertDiscToNJS(source){
    return {
        ...source,
        left: source.left * 512,
        total: source.total * 512,
        groups: source.groups.map(convertGroupToNJS),
    };
}

export function convertGroupToWMD(source){
    return {
        ...source,
        tracks: source.tracks.map(convertTrackToWMD)
    };
}

export function convertGroupToNJS(source){
    return {
        ...source,
        tracks: source.tracks.map(convertTrackToNJS),
    };
}

export function convertTrackToWMD(source){
    return ({
        ...source,
        duration: Math.ceil(source.duration / 512),
        encoding: ({
            [Encoding.sp]: { codec: "SP" },
            [Encoding.lp2]: { codec: "LP2" },
            [Encoding.lp4]: { codec: "LP4" },
        })[source.encoding],
    });
}

export function convertTrackToNJS(source){
    return {
        ...source,
        duration: source.duration * 512,
        encoding: ({
            "SP": Encoding.sp,
            "LP2": Encoding.lp2,
            "LP4": Encoding.lp4,
        })[["SP", "LP2", "LP4"].includes(source.encoding.codec) ? source.encoding.codec : "SP"],
    }
}

function isSequential(numbers) {
    if (numbers.length === 0) return true;
    let last = numbers[0];
    for (let num of numbers) {
        if (num === last) {
            ++last;
        } else return false;
    }
    return true;
}

const webusb = new WebUSB({
    allowedDevices: DevicesIds.map(({
        deviceId,
        vendorId
    }) => ({
        deviceId,
        vendorId
    })),
    deviceTimeout: 1000000,
});
const mutex = new Mutex();

const netmdLogger = {
    debug: () => {},
    info: console.log,
    warn: console.log,
    error: console.log,
    child: () => netmdLogger,
};

let awaitingDeviceLockMutexRelease = null;
let device = null;
let cachedContent = undefined;

async function getCachedContent() {
    if (!cachedContent) cachedContent = await listContent(device);
    return cachedContent;
}

function flushCache() {
    cachedContent = undefined;
}

function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}


function fail(res, error) {
    try {
        res.json({
            ok: false,
            error
        });
    } catch (err) {}
}

function success(res, value) {
    try {
        res.json(value ? {
            ok: true,
            value
        } : {
            ok: true
        });
    } catch (err) {}
}

async function awaitPromiseReturnStatus(promise, res) {
    try{
        success(res, await promise);
    }catch(ex){
        fail(res, ex);
    }
}

function assertPresent(res, value) {
    if ((isNaN(value) && (typeof value === 'number')) || value === undefined || value === null) {
        fail(res, "Missing parameter.");
        return false;
    }
    return true;
}

async function main() {

    const args = yargs(hideBin(process.argv))
        .option("https", {
            type: "boolean",
            describe: "Use HTTPS instead of HTTP",
        })
        .option("httpsCert", {
            type: "string",
            describe: "The HTTPS certificate",
        })
        .option("httpsKey", {
            type: "string",
            describe: "The HTTPS key",
        })
        .option("port", {
            type: "number",
            describe: "The port on which to host",
        })
        .default("port", 11396)
        .default("https", true)
        .default("httpsCert", "cert.pem")
        .default("httpsKey", "key.pem")
        .help()
        .parse();

    const {
        port,
        https: useHttps,
        httpsCert,
        httpsKey
    } = args;
    // ********************** Express initialization *********************
    const app = express();
    const server = useHttps ? https.createServer({
        key: fs.readFileSync(httpsKey),
        cert: fs.readFileSync(httpsCert),
    }, app) : http.createServer(app);
    expressWs(app, server);
    app.use(express.json());

    // Make sure there is no way to call two methods at the same time.
    app.use((req, res, next) => {
        res.set("Access-Control-Allow-Origin", "*");
        res.set("Access-Control-Allow-Headers", "Content-Type");
        if (awaitingDeviceLockMutexRelease) {
            fail(res, "Not ready.");
            return;
        }
        console.log(`Called ${req.url}`);
        if (!req.url.includes("upload"))
            mutex.acquire().then(release => {
                res.on('finish', release);
                res.on('error', (e) => {
                    console.log(`Error while handling: ${e}.`);
                    release();
                });
                res.on('close', release);
                next();
            }).catch(ex => console.log(ex));
        else next();
    });

    // Fliter out preflight requests
    app.use((req, res, next) => {
        if(req.method === "OPTIONS"){
            console.log(`Preflight request to ${req.url}`);
            if(req.header("Access-Control-Request-Private-Network") === "true"){
                res.header("Access-Control-Allow-Private-Network", "true");
            }
            res.status(204).send("");
            return;
        }
        next();
    });

    setup(app);

    // *********************** NetMD initialization **********************
    setTimeout(async function reloadDevices() {
        try{
            if (awaitingDeviceLockMutexRelease) {
                device = await openNewDevice(webusb, netmdLogger);
                if (device !== null) {
                    awaitingDeviceLockMutexRelease();
                    awaitingDeviceLockMutexRelease = null;
                    console.log("New device connected! Application resumed.");
                    cachedContent = null;
                }
            }
        }catch(ex){
            console.log(ex);
        }
        setTimeout(reloadDevices, 1000);
    }, 1000);

    webusb.addEventListener("disconnect", () => {
        if(mutex.isLocked()){
            mutex.cancel();
            mutex.release();
        }
        device = null;
        console.log("Device disconnected.");
        console.log("Awaiting new device...");
        flushCache();
        mutex.acquire().then(release => awaitingDeviceLockMutexRelease = release);
    });

    device = await openNewDevice(webusb, netmdLogger);

    if (device === null) {
        console.log("Error: No NetMD devices found.");
        console.log("Awaiting new device...");
        mutex.acquire().then(release => awaitingDeviceLockMutexRelease = release);
    } else {
        console.log(`Connected to ${device.netMd.getDeviceName()}`);
    }


    server.listen(port, () => console.log(`Started ${useHttps ? "https" : "http"} server on port ${port}.`));
}
main();

function setup(app) {
    // ********************* NetMD <==> REST bridge **********************
    // Basic pages:
    app.get("/", (req, res) => {
        success(res, {
            device: device.netMd.getDeviceName(),
            capabilities: ['contentList', 'playbackControl', 'metadataEdit', 'trackUpload'],
            version: '1.0',
        });
    });

    app.get('/deviceStatus', async (req, res) => {
        const devStat = await getDeviceStatus(device);
        if(!devStat.discPresent) flushCache();
        success(res, devStat);
    });

    // The 'contentList' capability:

    app.get('/listContent', (req, res) => {
        if(req.query.flushCache){
            flushCache();
        }
        awaitPromiseReturnStatus(new Promise(async (res, rej) => {
            try{
                const content = await getCachedContent();
                return res(convertDiscToWMD(content));
            }catch(ex){
                rej(ex);
            }
        }), res);
    });

    app.get('/deviceName', (req, res) => {
        success(res, device.netMd.getDeviceName());
    });

    // The 'metadataEdit' capability:

    app.get('/renameTrack', async (req, res) => {
        let {
            index,
            title,
            fullWidthTitle
        } = req.query;

        index = parseInt(index);
        if (!assertPresent(res, title) || !assertPresent(res, index)) return;

        await device.setTrackTitle(index, title, false);
        if (fullWidthTitle !== undefined) {
            await device.setTrackTitle(index, fullWidthTitle, true);
        }
        flushCache();
        success(res);
    });

    app.get('/renameDisc', (req, res) => {
        let {
            title,
            fullWidthTitle
        } = req.query;
        if (!fullWidthTitle) fullWidthTitle = '';
        if (!assertPresent(res, title)) return;
        flushCache();
        awaitPromiseReturnStatus(renameDisc(device, title, fullWidthTitle), res);
    });

    app.get('/renameGroup', async (req, res) => {
        let {
            groupIndex,
            title,
            fullWidthTitle
        } = req.query;
        if (!fullWidthTitle) fullWidthTitle = '';
        groupIndex = parseInt(groupIndex);
        if (!assertPresent(res, groupIndex) || !assertPresent(res, title)) return;

        const disc = await getCachedContent();
        let thisGroup = disc.groups.find(g => g.index === groupIndex);
        if (!thisGroup) {
            return;
        }

        thisGroup.title = title;
        if (fullWidthTitle !== undefined) {
            thisGroup.fullWidthTitle = fullWidthTitle;
        }
        awaitPromiseReturnStatus(rewriteDiscGroups(device, disc), res);
        flushCache();
    });

    app.get('/addGroup', async (req, res) => {
        let {
            groupBegin,
            groupLength,
            title
        } = req.query;
        const disc = await getCachedContent();

        groupBegin = parseInt(groupBegin);
        groupLength = parseInt(groupLength);

        if (!assertPresent(res, groupBegin) || !assertPresent(res, groupLength)) return;

        let ungrouped = disc.groups.find(n => n.title === null);
        if (!ungrouped) {
            fail(res, "No groupable tracks on the disc.");
            return; // You can only group tracks that aren't already in a different group, if there's no such tracks, there's no point to continue
        }

        let ungroupedLengthBeforeGroup = ungrouped.tracks.length;

        let thisGroupTracks = ungrouped.tracks.filter(n => n.index >= groupBegin && n.index < groupBegin + groupLength);
        ungrouped.tracks = ungrouped.tracks.filter(n => !thisGroupTracks.includes(n));

        if (ungroupedLengthBeforeGroup - ungrouped.tracks.length !== groupLength) {
            throw new Error('A track cannot be in 2 groups!');
        }

        if (!isSequential(thisGroupTracks.map(n => n.index))) {
            throw new Error('Invalid sequence of tracks!');
        }

        disc.groups.push({
            title,
            fullWidthTitle: '',
            index: disc.groups.length,
            tracks: thisGroupTracks,
        });
        disc.groups = disc.groups.filter(g => g.tracks.length !== 0).sort((a, b) => a.tracks[0].index - b.tracks[0].index);
        flushCache();
        awaitPromiseReturnStatus(rewriteDiscGroups(device, disc), res);
    });

    app.get('/deleteGroup', async (req, res) => {
        let {
            index
        } = req.query;
        index = parseInt(index);
        if (!assertPresent(res, index)) return;

        const disc = await getCachedContent();

        let groupIndex = disc.groups.findIndex(g => g.index === index);
        if (groupIndex >= 0) {
            disc.groups.splice(groupIndex, 1);
        }
        flushCache();
        awaitPromiseReturnStatus(rewriteDiscGroups(device, disc), res);
    });

    app.post('/rewriteGroups', async (req, res) => {
        if (!assertPresent(res, req.body.groups));
        awaitPromiseReturnStatus(rewriteDiscGroups(device, {
            ...getCachedContent(),
            groups: req.body.groups.map(convertGroupToNJS)
        }), res);
        flushCache();
    });

    app.post('/deleteTracks', async (req, res) => {
        if (!assertPresent(res, req.body.indexes) || !assertPresent(res, Array.isArray(req.body.indexes))) return;
        let indexes = req.body.indexes;
        for (let i = 0; i < indexes.length; i++) {
            indexes[i] = parseInt(indexes[i]);
            if (!assertPresent(res, indexes[i])) return;
        }
        indexes = indexes.sort();
        indexes.reverse();
        let content = await getCachedContent();
        for (let index of indexes) {
            //content = recomputeGroupsAfterTrackMove(content, index, -1);
            await device.eraseTrack(index);
            await sleep(100);
        }
        flushCache();
        awaitPromiseReturnStatus(rewriteDiscGroups(device, content), res);
    });

    app.get('/moveTrack', async (req, res) => {
        let {
            src,
            dst
        } = req.query;

        src = parseInt(src);
        dst = parseInt(dst);

        if (!assertPresent(res, src) || !assertPresent(res, src)) return;
        flushCache();
        awaitPromiseReturnStatus(device.moveTrack(src, dst), res);
    });

    app.get('/wipeDisc', (req, res) => {
        flushCache();
        awaitPromiseReturnStatus(device.eraseDisc(), res);
    });

    // The 'playbackControl' capability:

    app.get('/play', (req, res) => awaitPromiseReturnStatus(device.play(), res));
    app.get('/pause', (req, res) => awaitPromiseReturnStatus(device.pause(), res));
    app.get('/stop', (req, res) => awaitPromiseReturnStatus(device.stop(), res));
    app.get('/next', (req, res) => awaitPromiseReturnStatus(device.nextTrack(), res));
    app.get('/prev', (req, res) => awaitPromiseReturnStatus(device.previousTrack(), res));
    app.get('/goto', (req, res) => {
        let {
            index
        } = req.query;
        index = parseInt(index);
        if (!assertPresent(res, index)) return;
        awaitPromiseReturnStatus(device.gotoTrack(index), res);
    });
    app.get('/gotoTime', (req, res) => {
        let {
            index,
            hour,
            minute,
            second,
            frame
        } = req.query;
        index = parseInt(index);
        hour = parseInt(hour);
        minute = parseInt(minute);
        second = parseInt(second);
        frame = parseInt(frame);
        if (!assertPresent(res, index) || !assertPresent(res, hour) || !assertPresent(res, minute) || !assertPresent(res, second) || !assertPresent(res, frame)) return;
        awaitPromiseReturnStatus(device.gotoTime(track, hour, minute, second, frame));
    });
    app.get('/getPosition', (req, res) => awaitPromiseReturnStatus(device.getPosition(), res));
    let session = null;
    app.get('/prepareUpload', async (req, res) => {
        await prepareDownload(device);
        session = new MDSession(device, new EKBOpenSource());
        await session.init();
        success(res);
    });
    app.get('/finalizeUpload', async (req, res) => {
        await session.close();
        await device.release();
        session = null;
        flushCache();
        success(res);
    });

    app.ws('/upload', (ws, req) => {
        if(!session){
            console.log("You need to call /prepareUpload first");
            ws.close();
        }
        mutex.acquire().then(async release => {
            let {
                title,
                fullWidthTitle,
                format,
                totalLength,
                chunked
            } = req.query;
            if (!fullWidthTitle) fullWidthTitle = '';
            if (title === undefined || title === null || format === undefined || format === null) ws.close();
            const WireformatDict = {
                SP: Wireformat.pcm,
                LP2: Wireformat.lp2,
                LP105: Wireformat.l105kbps,
                LP4: Wireformat.lp4,
            };
            format = WireformatDict[format];

            let written = 0;

            let lastTime = 0;

            function updateProgress() {
                let newTime = new Date().getTime();
                if(newTime - lastTime > 100){
                    ws.send(JSON.stringify({
                        written
                    }));
                    lastTime = newTime;
                }
            }

            let halfWidthTitle = sanitizeHalfWidthTitle(title);
            fullWidthTitle = sanitizeFullWidthTitle(fullWidthTitle);

            let queue = [];

            ws.on('message', async _piece => {
                // Deserialize data
                try{
                    const piece = new Uint8Array(_piece);
                    const type = piece[0];
                    if(type === 0){
                        const iv = piece.subarray(1, 9);
                        const key = piece.subarray(9, 17);
                        const data = piece.subarray(17);
                        queue.push({ iv, key, data });
                    }else{
                        console.log(`As of the start of upload, received ${queue.length} packets. Expecting ${totalLength} bytes got ${queue.reduce((a, b) => a + b.data.length, 0)}`);
                        let mdTrack = new MDTrack(halfWidthTitle, format, {
                            byteLength: parseInt(totalLength),
                        }, 0x400, fullWidthTitle, () => ({
                            async *[Symbol.asyncIterator](){
                                for(let e of queue){
                                    yield e;
                                }
                            }
                        }));
                        await session.downloadTrack(mdTrack, ({
                            writtenBytes
                        }) => {
                            written = writtenBytes;
                            updateProgress();
                        });

                        flushCache();
                        ws.send(JSON.stringify({ terminate: true }));
                        console.log("Upload completed.");
                        release();

                    }
                }catch(ex){
                    console.log(ex);
                }
            });

            ws.send(JSON.stringify({ init: true }));
        }).catch(e => console.log(e));
    });

    app.get('/upload', (res, req) => fail(req, "This is a WebSocket-only endpoint."));
}
