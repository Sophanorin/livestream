/* eslint-disable no-unused-expressions */
import Logger from "./Logger";
import hark from "hark";
import { getSignalingUrl } from "./urlFactory";
import { debounce, SocketTimeoutError } from "./utils";
import * as requestActions from "./store/actions/requestActions";
import * as meActions from "./store/actions/meActions";
import * as intlActions from "./store/actions/intlActions";
import * as roomActions from "./store/actions/roomActions";
import * as peerActions from "./store/actions/peerActions";
import * as peerVolumeActions from "./store/actions/peerVolumeActions";
import * as settingsActions from "./store/actions/settingsActions";
import * as chatActions from "./store/actions/chatActions";
import * as fileActions from "./store/actions/fileActions";
import * as lobbyPeerActions from "./store/actions/lobbyPeerActions";
import * as consumerActions from "./store/actions/consumerActions";
import * as producerActions from "./store/actions/producerActions";
import * as notificationActions from "./store/actions/notificationActions";
import * as transportActions from "./store/actions/transportActions";
import * as documentActions from "./store/actions/documentActions";
import * as whiteboardActions from "./store/actions/whiteboardActions";
import * as quizActions from "./store/actions/quizActions";
import * as dockActions from "./store/actions/dockActions";
import * as presentationActions from "./store/actions/presentationActions";
import Spotlights from "./Spotlights";
import { permissions } from "./permissions";
import * as locales from "./intl/locales";
import { createIntl } from "react-intl";
import {
    RECORDING_START,
    RECORDING_STOP,
    RECORDING_PAUSE,
    RECORDING_RESUME,
} from "./store/actions/recorderActions";

import {
    directReceiverTransform,
    opusReceiverTransform,
} from "./transforms/receiver";

import * as Service from "./services";

import YoutubeVideoManager from "./YoutubeVideoManager";
import ClassDocumentManager from "./ClassDocumentManager";
import whiteboardManager from "./WhiteboardManager";
import { BreakoutRoomsManager } from "./BreakoutRoomsManager";
import Recorder from "./Recorder";
import { PAGE_CHANGE_LATENCY } from "./constances";

// let WebTorrent;

let saveAs;

let mediasoupClient;

let io;

let ScreenShare;

const requestTimeout = window.config.requestTimeout | 20000;


const logger = new Logger("RoomClient");

const VIDEO_CONSTRAINS = {
    low : {
        width : 320,
    },
    medium : {
        width : 640,
    },
    high : {
        width : 1280,
    },
    veryhigh : {
        width : 1920,
    },
    ultra : {
        width : 3840,
    },
};

const DEFAULT_NETWORK_PRIORITIES = {
    audio            : "high",
    mainVideo        : "high",
    additionalVideos : "medium",
    screenShare      : "medium",
};

function getVideoConstrains(resolution, aspectRatio) {
    return {
        width  : { ideal: VIDEO_CONSTRAINS[resolution].width },
        height : { ideal: VIDEO_CONSTRAINS[resolution].width / aspectRatio },
    };
}

const PC_PROPRIETARY_CONSTRAINTS = {
    optional : [{ googDscp: true }],
};

const VIDEO_SIMULCAST_PROFILES = {
    3840 : [
        { scaleResolutionDownBy: 12, maxBitRate: 150000 },
        { scaleResolutionDownBy: 6, maxBitRate: 500000 },
        { scaleResolutionDownBy: 1, maxBitRate: 10000000 },
    ],
    1920 : [
        { scaleResolutionDownBy: 6, maxBitRate: 150000 },
        { scaleResolutionDownBy: 3, maxBitRate: 500000 },
        { scaleResolutionDownBy: 1, maxBitRate: 3500000 },
    ],
    1280 : [
        { scaleResolutionDownBy: 4, maxBitRate: 150000 },
        { scaleResolutionDownBy: 2, maxBitRate: 500000 },
        { scaleResolutionDownBy: 1, maxBitRate: 1200000 },
    ],
    640 : [
        { scaleResolutionDownBy: 2, maxBitRate: 150000 },
        { scaleResolutionDownBy: 1, maxBitRate: 500000 },
    ],
    320 : [{ scaleResolutionDownBy: 1, maxBitRate: 150000 }],
};

// Used for VP9 webcam video.
const VIDEO_KSVC_ENCODINGS = [{ scalabilityMode: "S3T3_KEY" }];

// Used for VP9 desktop sharing.
const VIDEO_SVC_ENCODINGS = [{ scalabilityMode: "S3T3", dtx: true }];

const MAX_FILE_SIZE = window.config.maxFileSize || 2000000;

/**
 * Validates the simulcast `encodings` array extracting the resolution scalings
 * array.
 * ref. https://www.w3.org/TR/webrtc/#rtp-media-api
 *
 * @param {*} encodings
 * @returns the resolution scalings array
 */
function getResolutionScalings(encodings) {
    const resolutionScalings = [];

    // SVC encodings
    if (encodings.length === 1) {
        const { spatialLayers } = mediasoupClient.parseScalabilityMode(
            encodings[0].scalabilityMode
        );

        for (let i = 0; i < spatialLayers; i++) {
            resolutionScalings.push(2 ** (spatialLayers - i - 1));
        }

        return resolutionScalings;
    }

    // Simulcast encodings
    let scaleResolutionDownByDefined = false;

    encodings.forEach((encoding) => {
        if (encoding.scaleResolutionDownBy !== undefined) {
            // at least one scaleResolutionDownBy is defined
            scaleResolutionDownByDefined = true;
            // scaleResolutionDownBy must be >= 1.0
            resolutionScalings.push(
                Math.max(1.0, encoding.scaleResolutionDownBy)
            );
        } else {
            // If encodings contains any encoding whose scaleResolutionDownBy
            // attribute is defined, set any undefined scaleResolutionDownBy
            // of the other encodings to 1.0.
            resolutionScalings.push(1.0);
        }
    });

    // If the scaleResolutionDownBy attribues of sendEncodings are
    // still undefined, initialize each encoding's scaleResolutionDownBy
    // to 2^(length of sendEncodings - encoding index - 1).
    if (!scaleResolutionDownByDefined) {
        encodings.forEach((encoding, index) => {
            resolutionScalings[index] = 2 ** (encodings.length - index - 1);
        });
    }

    return resolutionScalings;
}

let store;

let intl;

const insertableStreamsSupported = Boolean(
    RTCRtpSender.prototype.createEncodedStreams
);

export default class RoomClient {
    /**
     * @param  {Object} data
     * @param  {Object} data.store - The Redux store.
     * @param  {Object} data.intl - react-intl object
     */
    static init(data) {
        store = data.store;
    }

    //headless
    constructor({
        accessCode,
        device,
        produce,
        forceTcp,
        basePath,
        muted,
        peerId,
    } = {}) {
        if (!peerId) {
            throw new Error("Missing peerId");
        }
        if (!device) {
            throw new Error("Missing device");
        }

        logger.debug(
            'constructor() [ device: "%s", produce: "%s", forceTcp: "%s", displayName ""]',
            device.flag,
            produce,
            forceTcp
        );

        this._joined = false;

        this._signalingUrl = null;

        // Closed flag.
        this._closed = false;

        // Whether we should produce.
        this._produce = produce;

        // Whether we force TCP
        this._forceTcp = forceTcp;

        // URL basepath
        this._basePath = basePath;

        this._tracker = "wss://tracker.lab.vvc.niif.hu:443";

        // Torrent support
        // this._torrentSupport = null;

        // Our WebTorrent client
        // this._webTorrent = null;

        // Whether simulcast should be used.
        this._useSimulcast = window.config.simulcast || false;

        // Whether simulcast should be used for sharing
        this._useSharingSimulcast = window.config.simulcastSharing;

        this._muted = muted;

        // This device
        this._device = device;

        // Access code
        this._accessCode = accessCode;

        // Alert sound
        this._soundAlerts = {
            default : { audio: new Audio("/sounds/notify.mp3") },
        };
        if (window.config.notificationSounds) {
            for (const [k, v] of Object.entries(
                window.config.notificationSounds
            )) {
                if (v != null && v.play !== undefined) {
                    this._soundAlerts[k] = {
                        audio : new Audio(v.play),
                        delay : v.delay ? v.delay : 0,
                    };
                }
            }
        }

        // Speaker test sound
        this._speakerTestSound = new Audio(window.config.testSound.play);

        // Socket.io peer connection
        this._signalingSocket = null;

        // My peer id.
        this._peerId = peerId;

        this._displayName = store.getState().settings.displayName || null;

        // todo switch to another room mode // Ex. enableAnonymouse
        store.dispatch(roomActions.setAnonymouseMode(true));
        this._peerTk = null;

        this._userInfo = {
            displayName : this._displayName,
            email       : store.getState().me.email || null
        };

        // The room ID
        this._roomId = null;

        // The Encryption Key
        this._roomKey = null;

        // mediasoup-client Device instance.
        // @type {mediasoupClient.Device}
        this._mediasoupDevice = null;

        // Put the browser info into state
        store.dispatch(meActions.setBrowser(device));

        // Max spotlights
        if (device.platform === "desktop") {
            this._maxSpotlights = window.config.lastN;
        } else {
            this._maxSpotlights = window.config.mobileLastN;
        }

        store.dispatch(settingsActions.setLastN(this._maxSpotlights));

        // Manager of spotlight
        this._spotlights = new Spotlights(
            this._maxSpotlights,
            store.getState().settings.hideNoVideoParticipants,
            this
        );

        // Transport for sending.
        this._sendTransport = null;

        // Transport for receiving.
        this._recvTransport = null;

        // Local mic mediasoup Producer.
        this._micProducer = null;

        // Local mic hark
        this._hark = null;

        // Local MediaStream for hark
        this._harkStream = null;

        // Local webcam mediasoup Producer.
        this._webcamProducer = null;

        // Extra videos being produced
        this._extraVideoProducers = new Map();

        // Map of webcam MediaDeviceInfos indexed by deviceId.
        // @type {Map<String, MediaDeviceInfos>}
        this._webcams = {};

        this._audioDevices = {};

        this._audioOutputDevices = {};

        // mediasoup Consumers.
        // @type {Map<String, mediasoupClient.Consumer>}
        this._consumers = new Map();

        this._screenSharing = null;

        this._screenSharingProducer = null;

        this._quill = null;

        this._startKeyListener();

        this._startDevicesListener();

        this._startBeforeUnloadListener();

        this._startInitRoomMediaListener();

        this.setLocale(store.getState().intl.locale);

        this._youtubeManager = new YoutubeVideoManager(this, store);

        this._classDocumentManager = new ClassDocumentManager(this, store);

        this._whiteboardManager = new whiteboardManager(this, store);

        this._breakoutRoomsManager = new BreakoutRoomsManager(this, store);

        this._recorder = new Recorder(this);

        this._localSelectedMicId = null;
        this._localSelectedWebcamId = null;

        store.dispatch(
            settingsActions.setRecorderSupportedMimeTypes(
                this.getRecorderSupportedMimeTypes()
            )
        );

        // Receive transport restart ICE object
        this._recvRestartIce = { timer: null, restarting: false };

        // Send transport restart ICE object
        this._sendRestartIce = { timer: null, restarting: false };
    }

    get signalingSocket() {
        return this._signalingSocket;
    }

    get username() {
        const { displayName } = store.getState().settings;
        return displayName;
    }

    get roomKey() {
        return this._roomKey;
    }

    get roomId() {
        return this._roomId;
    }

    get recorder() {
        return this._recorder;
    }

    /**
     *
     * @returns {BreakoutRoomsManager}
     */
    getBreakoutRoomsManager() {
        return this._breakoutRoomsManager;
    }

    /**
     *
     * @returns {whiteboardManager}
     */
    getWhiteboardManager() {
        return this._whiteboardManager;
    }

    /**
     *
     * @returns {ClassDocumentManager}
     */
    getClassDocumentManager() {
        return this._classDocumentManager;
    }

    /**
     *
     * @returns {YoutubeVideoManager}
     */
    getYoutubeManager() {
        return this._youtubeManager;
    }

    setPeerId(peerId) {
        this._peerId = peerId;
    }

    async close() {
        if (this._closed) {
            return;
        }

        if (this.recorder.recorder) {
            await this.recorder.stopRecording();
        }

        this._closed = true;

        logger.debug("close()");

        this._signalingSocket.close();

        // Close mediasoup Transports.
        if (this._sendTransport) {
            this._sendTransport.close();
        }

        if (this._recvTransport) {
            this._recvTransport.close();
        }

        store.dispatch(roomActions.setRoomState("closed"));
        store.dispatch(roomActions.toggleJoined());
        // this.getYoutubeManager().dispose();

        this.clear();

        // page info
        // window.location = `/${this._roomId}`;
    }

    /**
     * Clear all Peers, Consumers, Chats, Files, Quizzes, QuizResults, Youtube
     */
    clear() {
        store.dispatch(peerActions.clearPeers());
        store.dispatch(consumerActions.clearConsumers());
        store.dispatch(chatActions.clearChat());
        store.dispatch(fileActions.clearFiles());
        store.dispatch(quizActions.clearQuiz());
        store.dispatch(quizActions.clearQuizResult());
        this.getYoutubeManager().dispose();
    }

    _askForPerms = async () => {
        const mediaPerms = store.getState().settings;

        if (!mediaPerms.video || !mediaPerms.audio) {
            navigator.mediaDevices
                .getUserMedia({
                    video : !mediaPerms.video,
                    audio : !mediaPerms.audio,
                })
                .then(async () => {
                    this.updateDevices();
                    const {
                        selectedAudioDevice,
                        selectedAudioOutputDevice,
                        selectedWebcam,
                    } = store.getState().settings;

                    if (!selectedAudioDevice) {
                        const audioDeviceId = await this._getAudioDeviceId();
                        store.dispatch(
                            settingsActions.setSelectedAudioDevice(
                                audioDeviceId
                            )
                        );
                    }

                    if (!selectedAudioOutputDevice) {
                        const audioOutputDeviceId =
                            await this._getAudioOutputDeviceId();
                        store.dispatch(
                            settingsActions.setSelectedAudioOutputDevice(
                                audioOutputDeviceId
                            )
                        );
                    }

                    if (!selectedWebcam) {
                        const webcamDeviceId = await this._getWebcamDeviceId();
                        store.dispatch(
                            settingsActions.setSelectedWebcamDevice(
                                webcamDeviceId
                            )
                        );
                    }
                })
                .catch((error) => {
                    logger.error("_askForPerms() %o", error);
                });
        }

        // navigator.permissions
        //     .query({ name: "microphone" })
        //     .then((permissionObj) => {
        //         console.log("permissionObj.state", permissionObj.state);
        //     })
        //     .catch((error) => {
        //         console.log("Got error :", error);
        //     });

        // navigator.permissions
        //     .query({ name: "camera" })
        //     .then((permissionObj) => {
        //         console.log("permissionObj.state", permissionObj.state);
        //     })
        //     .catch((error) => {
        //         console.log("Got error :", error);
        //     });
    };

    _startBeforeUnloadListener() {
        window.addEventListener("beforeunload", () => {
            this.getYoutubeManager().dispose();
        });
    }

    _startInitRoomMediaListener() {
        window.addEventListener("load", async () => {
            await this._askForPerms();
        });
    }

    _startKeyListener() {
        if (!store.getState().room.enableEventListenerKeys) {
            return;
        }
        // Add keydown event listener on document
        document.addEventListener("keydown", (event) => {
            if (event.repeat) {
                return;
            }
            const key = String.fromCharCode(event.which);

            const source = event.target;

            const exclude = ["input", "textarea", "div"];

            if (exclude.indexOf(source.tagName.toLowerCase()) === -1) {
                logger.debug('keyDown() [key:"%s"]', key);

                switch (key) {
                /*
					case String.fromCharCode(37):
					{
						const newPeerId = this._spotlights.getPrevAsSelected(
							store.getState().room.selectedPeerId);

						if (newPeerId) this.setSelectedPeer(newPeerId);
						break;
					}

					case String.fromCharCode(39):
					{
						const newPeerId = this._spotlights.getNextAsSelected(
							store.getState().room.selectedPeerId);

						if (newPeerId) this.setSelectedPeer(newPeerId);
						break;
					}
					*/

                case "A": {
                    // Activate advanced mode
                    store.dispatch(settingsActions.toggleAdvancedMode());
                    // store.dispatch(
                    //     requestActions.notify({
                    //         text: intl.formatMessage({
                    //             id: "room.toggleAdvancedMode",
                    //             defaultMessage: "Toggled advanced mode",
                    //         }),
                    //     })
                    // );
                    break;
                }

                case "1": {
                    // Set democratic view
                    store.dispatch(
                        roomActions.setDisplayMode("democratic")
                    );
                    // store.dispatch(
                    //     requestActions.notify({
                    //         text: intl.formatMessage({
                    //             id: "room.setDemocraticView",
                    //             defaultMessage:
                    //                 "Changed layout to democratic view",
                    //         }),
                    //     })
                    // );
                    break;
                }

                case "2": {
                    // Set filmstrip view
                    store.dispatch(roomActions.setDisplayMode("filmstrip"));
                    // store.dispatch(
                    //     requestActions.notify({
                    //         text: intl.formatMessage({
                    //             id: "room.setFilmStripView",
                    //             defaultMessage:
                    //                 "Changed layout to filmstrip view",
                    //         }),
                    //     })
                    // );
                    break;
                }

                case " ": {
                    // Push To Talk start
                    if (this._micProducer) {
                        if (this._micProducer.paused) {
                            this.unmuteMic();
                        }
                    }

                    break;
                }
                case "M": {
                    // Toggle microphone
                    if (this._micProducer) {
                        if (!this._micProducer.paused) {
                            this.muteMic();

                            // store.dispatch(
                            //     requestActions.notify({
                            //         text: intl.formatMessage({
                            //             id: "devices.microphoneMute",
                            //             defaultMessage:
                            //                 "Muted your microphone",
                            //         }),
                            //     })
                            // );
                        } else {
                            this.unmuteMic();

                            // store.dispatch(
                            //     requestActions.notify({
                            //         text: intl.formatMessage({
                            //             id: "devices.microphoneUnMute",
                            //             defaultMessage:
                            //                 "Unmuted your microphone",
                            //         }),
                            //     })
                            // );
                        }
                    } else {
                        this.updateMic({ start: true });

                        // store.dispatch(
                        //     requestActions.notify({
                        //         text: intl.formatMessage({
                        //             id: "devices.microphoneEnable",
                        //             defaultMessage:
                        //                 "Enabled your microphone",
                        //         }),
                        //     })
                        // );
                    }

                    break;
                }

                case "V": {
                    // Toggle video
                    if (this._webcamProducer) {
                        this.disableWebcam();
                    } else {
                        this.updateWebcam({ start: true });
                    }

                    break;
                }

                case "H": {
                    // Open help dialog
                    store.dispatch(roomActions.setHelpOpen(true));

                    break;
                }

                default: {
                    break;
                }
                }
            }
        });
        document.addEventListener(
            "keyup",
            (event) => {
                const key = String.fromCharCode(event.which);

                const source = event.target;

                const exclude = ["input", "textarea", "div"];

                if (exclude.indexOf(source.tagName.toLowerCase()) === -1) {
                    logger.debug('keyUp() [key:"%s"]', key);

                    switch (key) {
                    case " ": {
                        // Push To Talk stop
                        if (this._micProducer) {
                            if (!this._micProducer.paused) {
                                this.muteMic();
                            }
                        }

                        break;
                    }
                    default: {
                        break;
                    }
                    }
                }
                event.preventDefault();
            },
            true
        );
    }

    _startDevicesListener() {
        navigator.mediaDevices.addEventListener("devicechange", async () => {
            logger.debug(
                "_startDevicesListener() | navigator.mediaDevices.ondevicechange"
            );

            await this._updateAudioDevices();
            await this._updateWebcams();
            await this._updateAudioOutputDevices();

            // store.dispatch(
            //     requestActions.notify({
            //         text: intl.formatMessage({
            //             id: "devices.devicesChanged",
            //             defaultMessage:
            //                 "Your devices changed, configure your devices in the settings dialog",
            //         }),
            //     })
            // );
        });
    }

    setLocale(locale) {
        if (locale === null) {
            locale = locales.detect();
        }

        const one = locales.loadOne(locale);

        store.dispatch(
            intlActions.updateIntl({
                locale   : one.locale[0],
                messages : one.messages,
                list     : locales.getList(),
            })
        );

        intl = createIntl({
            locale   : store.getState().intl.locale,
            messages : store.getState().intl.messages,
        });

        document.documentElement.lang = store
            .getState()
            .intl.locale.toUpperCase();
    }

    login(roomId = this._roomId) {
        const url = `/auth/login?peerId=${this._peerId}&roomId=${roomId}`;

        window.open(url, "loginWindow");
    }

    logout(roomId = this._roomId) {
        window.open(
            `/auth/logout?peerId=${this._peerId}&roomId=${roomId}`,
            "logoutWindow"
        );
    }
    setLoggedIn(loggedIn) {
        logger.debug('setLoggedIn() | [loggedIn: "%s"]', loggedIn);

        store.dispatch(meActions.loggedIn(loggedIn));
    }

    setPicture(picture) {
        store.dispatch(settingsActions.setLocalPicture(picture));
        store.dispatch(meActions.setPicture(picture));
        this.changePicture(picture);
    }

    receiveLoginChildWindow(data) {
        logger.debug('receiveFromChildWindow() | [data:"%o"]', data);

        const { picture, peerId, email } = data;

        let displayName;

        if (typeof data.displayName === "undefined" || !data.displayName)
        {
            displayName = "";}
        else {
            displayName = data.displayName;
        }

        store.dispatch(settingsActions.setDisplayName(displayName));

        this._peerId = peerId;
        this._displayName = displayName;
        this._userInfo.email = email;
        this._userInfo.displayName = displayName;

        if (!store.getState().settings.localPicture) {
            this._userInfo.picture = picture;
            store.dispatch(meActions.setPicture(picture));
        }

        store.dispatch(meActions.loggedIn(true));
        store.dispatch(meActions.setEmail(email));
        store.dispatch(
            meActions.setMe({
                peerId,
                loginEnabled : true,
            })
        );
        
    }

    receiveLogoutChildWindow() {
        logger.debug("receiveLogoutChildWindow()");

        this._userInfo.email = null;
        store.dispatch(meActions.setEmail(null));

        if (!store.getState().settings.localPicture) {
            store.dispatch(meActions.setPicture(null));
        }

        store.dispatch(meActions.loggedIn(false));
    }

    async changeDisplayName(displayName) {
        // displayName = displayName.trim();

        logger.debug('changeDisplayName() [displayName:"%s"]', displayName);

        this._displayName = displayName;
        this._userInfo.displayName = displayName;

        store.dispatch(settingsActions.setDisplayName(displayName));
    }

    _soundNotification(type = "default") {
        const { notificationSounds } = store.getState().settings;

        if (notificationSounds) {
            const soundAlert =
                this._soundAlerts[type] === undefined
                    ? this._soundAlerts.default
                    : this._soundAlerts[type];

            const now = Date.now();

            if (
                soundAlert.last !== undefined &&
                now - soundAlert.last < soundAlert.delay
            ) {
                return;
            }
            soundAlert.last = now;

            const alertPromise = soundAlert.audio.play();

            if (alertPromise !== undefined) {
                alertPromise.then().catch((error) => {
                    logger.error('_soundAlert.play() [error:"%o"]', error);
                });
            }
        }
    }

    speakerTestPlay() {
        logger.debug("speakerTestPlay.play()");

        const { selectedAudioOutputDevice, speakerTestPlaying } =
            store.getState().settings;

        try {
            if (selectedAudioOutputDevice && !speakerTestPlaying) {
                const audio = this._speakerTestSound;

                audio.onended = () => {
                    store.dispatch(
                        settingsActions.setSpeakerTestPlaying(false)
                    );
                };

                if (typeof audio.setSinkId === "function") {
                    audio.setSinkId(selectedAudioOutputDevice);
                }

                audio.play();

                store.dispatch(settingsActions.setSpeakerTestPlaying(true));
            }
        } catch (error) {
            logger.error("Error test sound speaker [reason: %o]", error);
        }
    }

    timeoutCallback(callback) {
        let called = false;

        const interval = setTimeout(() => {
            if (called) {
                return;
            }
            called = true;
            callback(new SocketTimeoutError("Request timed out"));
        }, requestTimeout);

        return (...args) => {
            if (called) {
                return;
            }
            called = true;
            clearTimeout(interval);

            callback(...args);
        };
    }

    _sendRequest(method, data) {
        return new Promise((resolve, reject) => {
            if (!this._signalingSocket) {
                reject("No socket connection");
            } else {
                this._signalingSocket.emit(
                    "request",
                    { method, data },
                    this.timeoutCallback((err, response) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(response);
                        }
                    })
                );
            }
        });
    }

    async getTransportStats() {
        try {
            if (this._recvTransport) {
                logger.debug(
                    'getTransportStats() - recv [transportId: "%s"]',
                    this._recvTransport.id
                );

                const recv = await this.sendRequest("getTransportStats", {
                    transportId : this._recvTransport.id,
                });

                store.dispatch(
                    transportActions.addTransportStats(recv, "recv")
                );
            }

            if (this._sendTransport) {
                logger.debug(
                    'getTransportStats() - send [transportId: "%s"]',
                    this._sendTransport.id
                );

                const send = await this.sendRequest("getTransportStats", {
                    transportId : this._sendTransport.id,
                });

                store.dispatch(
                    transportActions.addTransportStats(send, "send")
                );
            }
        } catch (error) {
            logger.error('getTransportStats() [error:"%o"]', error);
        }
    }

    async sendRequest(method, data) {
        logger.debug('sendRequest() [method:"%s", data:"%o"]', method, data);

        const { requestRetries = 3 } = window.config;

        for (let tries = 0; tries < requestRetries; tries++) {
            try {
                return await this._sendRequest(method, data);
            } catch (error) {
                if (
                    error instanceof SocketTimeoutError &&
                    tries < requestRetries
                ) {
                    logger.warn(
                        `sendRequest() | timeout, retrying [attempt:${tries}]\n[error:${error}]`
                    );
                } else {
                    throw error;
                }
            }
        }
    }

    async changePicture(picture) {
        logger.debug('changePicture() [picture: "%s"]', picture);

        try {
            await this.sendRequest("changePicture", { picture });
        } catch (error) {
            logger.error('changePicture() [error:"%o"]', error);
        }
    }

    async sendChatMessage(chatMessage) {
        logger.debug('sendChatMessage() [chatMessage:"%s"]', chatMessage);

        try {
            store.dispatch(
                chatActions.addMessage({
                    ...chatMessage,
                    // name    : 'Me',
                    sender  : "client",
                    picture : undefined,
                    isRead  : true,
                })
            );

            store.dispatch(chatActions.setIsScrollEnd(true));

            await this.sendRequest("chatMessage", { chatMessage });
        } catch (error) {
            logger.error('sendChatMessage() [error:"%o"]', error);

            // store.dispatch(
            //     requestActions.notify({
            //         type: "error",
            //         text: intl.formatMessage({
            //             id: "room.chatError",
            //             defaultMessage: "Unable to send chat message",
            //         }),
            //     })
            // );
        }
    }

    saveFile(file) {
        file.getBlob((err, blob) => {
            if (err) {
                // store.dispatch(
                //     requestActions.notify({
                //         type: "error",
                //         text: intl.formatMessage({
                //             id: "filesharing.saveFileError",
                //             defaultMessage: "Unable to save file",
                //         }),
                //     })
                // );

                return;
            }

            saveAs(blob, file.name);
        });
    }

    async saveChat() {
        const html = window.document
            .getElementsByTagName("html")[0]
            .cloneNode(true);

        const chatEl = html.querySelector("#chatList");

        html.querySelector("body").replaceChildren(chatEl);

        const fileName = "chat.html";

        // remove unused tags
        ["script", "link"].forEach((element) => {
            const el = html.getElementsByTagName(element);

            let i = el.length;

            while (i--) {
                el[i].parentNode.removeChild(el[i]);
            }
        });

        // embed images
        for (const img of html.querySelectorAll("img")) {
            img.src = img.src;

            fetch({
                url : img.src,
            })
                .then((response) => response.blob())
                .then((data) => {
                    const reader = new FileReader();

                    reader.onloadend = () => {
                        img.src = reader.result;
                    };

                    reader.readAsDataURL(data);
                });
        }

        const blob = new Blob([html.innerHTML], {
            type : "text/html;charset=utf-8",
        });

        saveAs(blob, fileName);
    }

    sortChat(order) {
        store.dispatch(chatActions.sortChat(order));
    }

    async sendQuiz(quiz) {
        logger.debug('sendQuiz() [quiz:"%o"]', quiz);

        try {
            store.dispatch(
                quizActions.addQuiz({
                    ...quiz,
                    // name    : 'Me',
                    sender         : "client",
                    isRead         : true,
                    answered       : true,
                    isPublicResult : false,
                    answeredPeers  : [],
                })
            );

            await this.sendRequest("quiz", {
                method : "moderator:sendQuiz",
                data   : {
                    quiz : {
                        ...quiz,
                        isPublicResult : false,
                        isRead         : false,
                        answeredPeers  : [],
                    },
                },
            });

            store.dispatch(quizActions.setSenderWatching(true, quiz.time));
            store.dispatch(chatActions.setIsScrollEnd(true));
        } catch (error) {
            logger.error('sendQuiz() [error:"%o"]', error);

            // store.dispatch(
            //     requestActions.notify({
            //         type: "error",
            //         text: intl.formatMessage({
            //             id: "room.quizError",
            //             defaultMessage: "Unable to send quiz",
            //         }),
            //     })
            // );
        }
    }

    async submitQuiz(quiz, peerAnswerIndexs) {
        logger.debug(
            'submitQuiz() [peerAnswerIndex: %s] to [quiz:"%o"]',
            peerAnswerIndexs,
            quiz
        );

        await this.sendRequest("quiz", {
            method : "submitQuiz",
            data   : {
                time             : quiz.time,
                peerAnswerIndexs : peerAnswerIndexs.sort((a, b) => a - b),
            },
        });

        store.dispatch(
            quizActions.setPeerCorrectIndex(quiz.time, peerAnswerIndexs)
        );

        try {
        } catch (error) {
            logger.error('submitQuiz() [error:"%o"]', error);

            // store.dispatch(
            //     requestActions.notify({
            //         type: "error",
            //         text: intl.formatMessage({
            //             id: "room.submitQuizError",
            //             defaultMessage: "Unable to submit quiz",
            //         }),
            //     })
            // );
        }
    }
    async publicQuizResult(quiz) {
        logger.debug("publicQuizResult() [quiz: %o]", quiz);
        try {
            const peersLength = Object.keys(store.getState().peers).length;

            const result = {
                time             : quiz.time,
                maxAnsweredPeers : peersLength,
                correctIndexs    : quiz.correctIndexs,
                answeredPeers    : quiz.answeredPeers,
                isPublicResult   : true,
                answerColors     : quiz.answerColors,
            };

            store.dispatch(quizActions.updateQuiz(result));

            await this.sendRequest("quiz", {
                method : "publicQuizResult",
                data   : {
                    result,
                },
            });
        } catch (error) {
            logger.error('publicQuizResult() [error:"%o"]', error);

            // store.dispatch(
            //     requestActions.notify({
            //         type: "error",
            //         text: intl.formatMessage({
            //             id: "room.publicQuizResultError",
            //             defaultMessage: "Unable to public quiz result",
            //         }),
            //     })
            // );
        }
    }

    async handleDownload(url) {
        const fileName = url.split("/").pop();

        await Service.download(url, fileName);
    }

    _handleTorrent(torrent) {
        // Torrent already done, this can happen if the
        // same file was sent multiple times.
        if (torrent.progress === 1) {
            store.dispatch(
                fileActions.setFileDone(torrent.magnetURI, torrent.files)
            );

            return;
        }

        let lastMove = 0;

        torrent.on("download", () => {
            if (Date.now() - lastMove > 1000) {
                store.dispatch(
                    fileActions.setFileProgress(
                        torrent.magnetURI,
                        torrent.progress
                    )
                );

                lastMove = Date.now();
            }
        });

        torrent.on("done", () => {
            store.dispatch(
                fileActions.setFileDone(torrent.magnetURI, torrent.files)
            );
        });
    }

    reachMaxFileSize (files) {
        let reach = false;

        Array.from(files).forEach(file => {
            if (file.size > MAX_FILE_SIZE) {
                reach = true
            }
        })

        return reach
    }

    async shareFiles(data) {
        try {
            const files = [];

            if (this.reachMaxFileSize(data.attachment)) {
                store.dispatch(
                    requestActions.notify({
                        text : intl.formatMessage({
                            id             : "filesharing.warningFileSize",
                            defaultMessage : "Up to 2MB of files can be uploaded",
                        }),
                    })
                );
            } else {
                Array.from(data.attachment).forEach((uploadFile) => {
                    const file = {
                        ...data,
                        peerId   : this._peerId,
                        upload   : true,
                        fileName : uploadFile.name,
                        fileSize : uploadFile.size,
                        fileType : uploadFile.type,
                        url      : null,
                    };

                    files.push(file);
                    store.dispatch(fileActions.addFileUpload(file));
                });

                const res = await Service.upload(data.attachment, {
                    keyPrefix : "livestream-thesis",
                });

                files.forEach((file) => {
                    store.dispatch(fileActions.removeFileUpload(file));
                });

                res.data.map((uploadedFile) => {
                    delete data.attachment;

                    const file = {
                        ...data,
                        peerId   : this._peerId,
                        upload   : false,
                        fileName : uploadedFile.filename,
                        fileSize : uploadedFile.size,
                        fileType : uploadedFile.mimetype,
                        url      : uploadedFile.url,
                    };

                    store.dispatch(fileActions.addFile(file));

                    this._sendFile(file);
                });
            }
        } catch (error) {
            logger.error("sendFile() [error: %o]", error);
            console.log(error)
        }
    }

    // Presentation File
    async closePresentationFile() {
        try {
            this._closePresentationFile();

            await this.sendRequest("presentFile", {
                method : "close",
            });
        } catch (error) {
            logger.error("error closePresentationFile [error: %o]", error);
        }
    }

    _closePresentationFile() {
        store.dispatch(presentationActions.clearSelectedFile());
    }

    async changePageNumber(id, pageNumber) {
        try {
            this._changePageNumber(id, pageNumber);

            debounce(async () => {
                await this.sendRequest("presentFile", {
                    method : "pageChange",
                    data   : { id, pageNumber },
                });
            }, PAGE_CHANGE_LATENCY)();
        } catch (error) {
            logger.error("error changePageNumber [error: %o]", error);
        }
    }

    _changePageNumber(id, pageNumber) {
        store.dispatch(presentationActions.setPage(id, pageNumber));
    }

    async presentFile(file) {
        logger.debug("start presentFile");

        try {
            this._presentFile(file);

            await this.sendRequest("presentFile", {
                method : "open",
                data   : { time: file.time, pageNumber: file.pageNumber },
            });
        } catch (error) {
            logger.error("error presentFile [error: %o]", error);
        }
    }

    _presentFile(file) {
        const { mode } = store.getState().room;

        if (mode !== "filmstrip") {
            store.dispatch(roomActions.setDisplayMode("filmstrip"));
        }

        const { selectedFile } = store.getState().presentation;

        if (selectedFile) {
            const dock = store.getState().docks[file.time];

            if (dock) {
                dock.open();
                return;
            } else if (selectedFile.time !== file.time) {
                this.minimizePresentationFile(selectedFile);
            }
        }

        store.dispatch(presentationActions.addPresentationFile(file));

        store.dispatch(presentationActions.setSelectedFile(file.time));

        // store.dispatch(dockActions.removeDockItem(file.time));

        const { documentOpen, latexOpen } = store.getState().document;
        const { whiteboardOpen } = store.getState().whiteboard;

        if (documentOpen) {
            this.getClassDocumentManager().minimize();
        }

        if (whiteboardOpen) {
            this.getWhiteboardManager().minimize();
        }
    }

    async minimizePresentationFile() {
        try {
            const { selectedFile } = store.getState().presentation;

            if (!selectedFile) {return;}

            this._minimizePresentationFile(selectedFile, {
                open : () => {
                    this._minimizePresentationFile(selectedFile);

                    this.presentFile(selectedFile);

                    store.dispatch(
                        dockActions.removeDockItem(selectedFile.time)
                    );
                },
            });

            await this.sendRequest("presentFile", {
                method : "minimize",
                data   : { id: selectedFile.time },
            });
        } catch (error) {
            logger.error("error minimizePresentationFile [error: %o]", error);
        }
    }

    _minimizePresentationFile(file = null, options = { open: null }) {
        if (!file) {return;}

        const minimizeFile = file;

        const handleOpenDockFile = () => {
            this._minimizePresentationFile(minimizeFile);

            store.dispatch(
                presentationActions.setSelectedFile(minimizeFile.time)
            );
            store.dispatch(dockActions.removeDockItem(minimizeFile.time));
        };

        store.dispatch(
            dockActions.addDockItem({
                id   : minimizeFile.time,
                type : minimizeFile.fileType,
                name : minimizeFile.fileName,
                open : options.open || handleOpenDockFile,
            })
        );

        this._closePresentationFile();
    }

    async _sendFile(file) {
        logger.debug('sendFile() [magnetUri:"%o"]', file.magnetUri);

        try {
            await this.sendRequest("sendFile", file);
        } catch (error) {
            logger.error('_sendFile() [error:"%o"]', error);
        }
    }

    async muteMic() {
        logger.debug("muteMic()");

        this._micProducer.pause();

        try {
            await this.sendRequest("pauseProducer", {
                producerId : this._micProducer.id,
            });

            store.dispatch(
                producerActions.setProducerPaused(this._micProducer.id)
            );

            store.dispatch(settingsActions.setAudioMuted(true));
        } catch (error) {
            logger.error('muteMic() [error:"%o"]', error);

            // store.dispatch(
            //     requestActions.notify({
            //         type: "error",
            //         text: intl.formatMessage({
            //             id: "devices.microphoneMuteError",
            //             defaultMessage: "Unable to mute your microphone",
            //         }),
            //     })
            // );
        }
    }

    async unmuteMic() {
        logger.debug("unmuteMic()");

        if (!this._micProducer) {
            this.updateMic({ start: true });
        } else {
            this._micProducer.resume();

            try {
                await this.sendRequest("resumeProducer", {
                    producerId : this._micProducer.id,
                });

                store.dispatch(
                    producerActions.setProducerResumed(this._micProducer.id)
                );

                store.dispatch(settingsActions.setAudioMuted(false));
            } catch (error) {
                logger.error('unmuteMic() [error:"%o"]', error);

                // store.dispatch(
                //     requestActions.notify({
                //         type: "error",
                //         text: intl.formatMessage({
                //             id: "devices.microphoneUnMuteError",
                //             defaultMessage: "Unable to unmute your microphone",
                //         }),
                //     })
                // );
            }
        }
    }

    changeMaxSpotlights(maxSpotlights) {
        this._spotlights.maxSpotlights = maxSpotlights;

        store.dispatch(settingsActions.setLastN(maxSpotlights));
    }
    // Updated consumers based on spotlights
    async updateSpotlights(spotlights) {
        logger.debug("updateSpotlights()");

        store.dispatch(roomActions.setSpotlights(spotlights));

        try {
            for (const consumer of this._consumers.values()) {
                if (consumer.kind === "video") {
                    if (spotlights.includes(consumer.appData.peerId)) {
                        await this._resumeConsumer(consumer);
                    } else {
                        await this._pauseConsumer(consumer);
                        store.dispatch(
                            roomActions.removeSelectedPeer(
                                consumer.appData.peerId
                            )
                        );
                    }
                }
            }
        } catch (error) {
            logger.error('updateSpotlights() [error:"%o"]', error);
        }
    }

    disconnectLocalHark() {
        logger.debug("disconnectLocalHark()");

        if (this._harkStream != null) {
            let [track] = this._harkStream.getAudioTracks();

            track.stop();
            track = null;

            this._harkStream = null;
        }

        if (this._hark != null) {
            this._hark.stop();
        }
    }

    connectLocalHark(track) {
        logger.debug('connectLocalHark() [track:"%o"]', track);

        this._harkStream = new MediaStream();

        const newTrack = track.clone();

        this._harkStream.addTrack(newTrack);

        newTrack.enabled = true;

        this._hark = hark(this._harkStream, {
            play      : false,
            interval  : 10,
            threshold : store.getState().settings.noiseThreshold,
            history   : 100,
        });

        this._hark.lastVolume = -100;

        this._hark.on("volume_change", (volume) => {
            // Update only if there is a bigger diff
            if (
                this._micProducer &&
                Math.abs(volume - this._hark.lastVolume) > 0.5
            ) {
                // Decay calculation: keep in mind that volume range is -100 ... 0 (dB)
                // This makes decay volume fast if difference to last saved value is big
                // and slow for small changes. This prevents flickering volume indicator
                // at low levels
                if (volume < this._hark.lastVolume) {
                    volume =
                        this._hark.lastVolume -
                        Math.pow(
                            (volume - this._hark.lastVolume) /
                                (100 + this._hark.lastVolume),
                            2
                        ) *
                            10;
                }

                this._hark.lastVolume = volume;

                store.dispatch(
                    peerVolumeActions.setPeerVolume(this._peerId, volume)
                );
            }
        });

        this._hark.on("speaking", () => {
            store.dispatch(meActions.setIsSpeaking(true));

            if (
                (store.getState().settings.voiceActivatedUnmute ||
                    store.getState().me.isAutoMuted) &&
                this._micProducer &&
                this._micProducer.paused
            ) {
                this._micProducer.resume();
            }

            store.dispatch(meActions.setAutoMuted(false)); // sanity action
        });

        this._hark.on("stopped_speaking", () => {
            store.dispatch(meActions.setIsSpeaking(false));

            if (
                store.getState().settings.voiceActivatedUnmute &&
                this._micProducer &&
                !this._micProducer.paused
            ) {
                this._micProducer.pause();

                store.dispatch(meActions.setAutoMuted(true));
            }
        });
    }

    async changeAudioOutputDevice(deviceId) {
        logger.debug('changeAudioOutputDevice() [deviceId:"%s"]', deviceId);

        store.dispatch(meActions.setAudioOutputInProgress(true));

        try {
            const device = this._audioOutputDevices[deviceId];

            if (!device) {
                throw new Error(
                    "Selected audio output device no longer available"
                );
            }

            store.dispatch(
                settingsActions.setSelectedAudioOutputDevice(deviceId)
            );

            await this._updateAudioOutputDevices();
        } catch (error) {
            logger.error('changeAudioOutputDevice() [error:"%o"]', error);
        }

        store.dispatch(meActions.setAudioOutputInProgress(false));
    }

    // Only Firefox supports applyConstraints to audio tracks
    // See:
    // https://bugs.chromium.org/p/chromium/issues/detail?id=796964
    async updateMic({
        start = false,
        restart = true,
        newDeviceId = null,
    } = {}) {
        logger.debug(
            'updateMic() [start:"%s", restart:"%s", newDeviceId:"%s"]',
            start,
            restart,
            newDeviceId
        );

        let track;

        try {
            if (!this._mediasoupDevice.canProduce("audio")) {
                throw new Error("cannot produce audio");
            }

            if (newDeviceId && !restart) {
                throw new Error("changing device requires restart");
            }

            if (newDeviceId) {
                store.dispatch(
                    settingsActions.setSelectedAudioDevice(newDeviceId)
                );
            }

            store.dispatch(meActions.setAudioInProgress(true));

            const deviceId = await this._getAudioDeviceId();
            const device = this._audioDevices[deviceId];

            if (!device) {
                throw new Error("no audio devices");
            }

            const {
                autoGainControl,
                echoCancellation,
                noiseSuppression,
                sampleRate,
                channelCount,
                sampleSize,
                opusStereo,
                opusDtx,
                opusFec,
                opusPtime,
                opusMaxPlaybackRate,
            } = store.getState().settings;

            if ((restart && this._micProducer) || start) {
                this.disconnectLocalHark();

                let muted = false;

                if (this._micProducer) {
                    muted = this._micProducer.paused;
                    await this.disableMic();
                }

                const stream = await navigator.mediaDevices.getUserMedia({
                    audio : {
                        deviceId : { ideal: deviceId },
                        sampleRate,
                        channelCount,
                        autoGainControl,
                        echoCancellation,
                        noiseSuppression,
                        sampleSize,
                    },
                });

                [track] = stream.getAudioTracks();

                const { deviceId: trackDeviceId } = track.getSettings();

                store.dispatch(
                    settingsActions.setSelectedAudioDevice(trackDeviceId)
                );

                const networkPriority = window.config.networkPriorities?.audio
                    ? window.config.networkPriorities?.audio
                    : DEFAULT_NETWORK_PRIORITIES.audio;

                this._micProducer = await this._sendTransport.produce({
                    track,
                    encodings : [
                        {
                            networkPriority,
                        },
                    ],
                    codecOptions : {
                        opusStereo,
                        opusFec,
                        opusDtx,
                        opusMaxPlaybackRate,
                        opusPtime,
                    },
                    appData : { source: "mic" },
                });

                store.dispatch(
                    producerActions.addProducer({
                        id            : this._micProducer.id,
                        source        : "mic",
                        paused        : this._micProducer.paused,
                        track         : this._micProducer.track,
                        rtpParameters : this._micProducer.rtpParameters,
                        codec         : this._micProducer.rtpParameters.codecs[0].mimeType.split(
                            "/"
                        )[1],
                    })
                );

                this._micProducer.on("transportclose", () => {
                    this._micProducer = null;
                });

                this._micProducer.on("trackended", () => {
                    // store.dispatch(
                    //     requestActions.notify({
                    //         type: "error",
                    //         text: intl.formatMessage({
                    //             id: "devices.microphoneDisconnected",
                    //             defaultMessage: "Microphone disconnected",
                    //         }),
                    //     })
                    // );

                    this.disableMic();
                });

                this.connectLocalHark(track);
                if (muted) {
                    this.muteMic();
                } else {
                    this.unmuteMic();
                }
            } else if (this._micProducer) {
                ({ track } = this._micProducer);

                await track.applyConstraints({
                    sampleRate,
                    channelCount,
                    autoGainControl,
                    echoCancellation,
                    noiseSuppression,
                    sampleSize,
                });

                if (this._harkStream != null) {
                    const [harkTrack] = this._harkStream.getAudioTracks();

                    harkTrack &&
                        (await harkTrack.applyConstraints({
                            sampleRate,
                            channelCount,
                            autoGainControl,
                            echoCancellation,
                            noiseSuppression,
                            sampleSize,
                        }));
                }
            }

            // TODO update recorder inputs
            /* 
			if (recorder != null)
			{
				recorder.addTrack(new MediaStream([ this._micProducer.track ]));
			}
			*/
            await this._updateAudioDevices();
        } catch (error) {
            logger.error('updateMic() [error:"%o"]', error);

            // store.dispatch(
            //     requestActions.notify({
            //         type: "error",
            //         text: intl.formatMessage({
            //             id: "devices.microphoneError",
            //             defaultMessage:
            //                 "An error occurred while accessing your microphone",
            //         }),
            //     })
            // );

            if (track) {
                track.stop();
            }
        }

        store.dispatch(meActions.setAudioInProgress(false));
    }

    getRecorderSupportedMimeTypes() {
        const mimeTypes = [];

        const mimeTypeCapability = [
            /* audio codecs
			[ 'audio/wav', [] ],
			[ 'audio/pcm', [] ],
			[ 'audio/webm', [ 'Chrome', 'Firefox', 'Safari' ] ],
			[ 'audio/ogg', [ 'Firefox' ] ],
			[ 'audio/opus', [] ],
			*/
            ["video/webm", ["Chrome", "Firefox", "Safari"]],
            ['video/webm;codecs="vp8, opus', ["Chrome", "Firefox", "Safari"]],
            ['video/webm;codecs="vp9, opus', ["Chrome"]],
            ['video/webm;codecs="h264, opus', ["Chrome"]],
            ["video/mp4", []],
            ["video/mpeg", []],
            ["video/x-matroska;codecs=avc1", ["Chrome"]],
        ];

        if (typeof MediaRecorder === "undefined") {
            window.MediaRecorder = {
                isTypeSupported() {
                    return false;
                },
            };
        }
        mimeTypeCapability.forEach((item) => {
            if (
                MediaRecorder.isTypeSupported(item[0]) &&
                !mimeTypes.includes(item[0])
            ) {
                mimeTypes.push(item[0]);
            }
        });

        return mimeTypes;
    }

    async updateWebcam({
        init = false,
        start = false,
        restart = false,
        newDeviceId = null,
        newResolution = null,
        newFrameRate = null,
    } = {}) {
        logger.debug(
            'updateWebcam() [start:"%s", restart:"%s", newDeviceId:"%s", newResolution:"%s", newFrameRate:"%s"]',
            start,
            restart,
            newDeviceId,
            newResolution,
            newFrameRate
        );

        let track;

        try {
            if (!this._mediasoupDevice.canProduce("video")) {
                throw new Error("cannot produce video");
            }

            if (newDeviceId && !restart) {
                throw new Error("changing device requires restart");
            }

            if (newDeviceId) {
                store.dispatch(
                    settingsActions.setSelectedWebcamDevice(newDeviceId)
                );
            }

            if (newResolution) {
                store.dispatch(
                    settingsActions.setVideoResolution(newResolution)
                );
            }

            if (newFrameRate) {
                store.dispatch(settingsActions.setVideoFrameRate(newFrameRate));
            }

            const { videoMuted } = store.getState().settings;

            if (init && videoMuted) {
                return;
            }
            store.dispatch(settingsActions.setVideoMuted(false));

            store.dispatch(meActions.setWebcamInProgress(true));

            const deviceId = await this._getWebcamDeviceId();
            const device = this._webcams[deviceId];

            if (!device) {
                throw new Error("no webcam devices");
            }

            const { resolution, aspectRatio, frameRate } =
                store.getState().settings;

            if ((restart && this._webcamProducer) || start) {
                if (this._webcamProducer) {
                    await this.disableWebcam();
                }

                const videoContraints = getVideoConstrains(
                    resolution,
                    aspectRatio
                );

                const stream = await navigator.mediaDevices.getUserMedia({
                    video : {
                        deviceId : { ideal: deviceId },
                        ...videoContraints,
                        frameRate,
                    },
                });

                [track] = stream.getVideoTracks();

                const {
                    deviceId: trackDeviceId,
                    width,
                    height,
                } = track.getSettings();

                logger.debug(
                    "getUserMedia track settings:",
                    track.getSettings()
                );

                store.dispatch(
                    settingsActions.setSelectedWebcamDevice(trackDeviceId)
                );

                const networkPriority = window.config.networkPriorities
                    ?.mainVideo
                    ? window.config.networkPriorities?.mainVideo
                    : DEFAULT_NETWORK_PRIORITIES.mainVideo;

                if (this._useSimulcast) {
                    const encodings = this._getEncodings(width, height);
                    const resolutionScalings = getResolutionScalings(encodings);

                    /** 
					 * TODO: 
					 * I receive DOMException: 
					 * Failed to execute 'addTransceiver' on 'RTCPeerConnection': 
					 * Attempted to set an unimplemented parameter of RtpParameters.
					encodings.forEach((encoding) =>
					{
						encoding.networkPriority=networkPriority;
					});
					*/
                    encodings[0].networkPriority = networkPriority;

                    this._webcamProducer = await this._sendTransport.produce({
                        track,
                        encodings,
                        codecOptions : {
                            videoGoogleStartBitrate : 1000,
                        },
                        appData : {
                            source : "webcam",
                            width,
                            height,
                            resolutionScalings,
                        },
                    });
                } else {
                    this._webcamProducer = await this._sendTransport.produce({
                        track,
                        encodings : [{ networkPriority }],
                        appData   : {
                            source : "webcam",
                            width,
                            height,
                        },
                    });
                }

                store.dispatch(
                    producerActions.addProducer({
                        id            : this._webcamProducer.id,
                        source        : "webcam",
                        paused        : this._webcamProducer.paused,
                        track         : this._webcamProducer.track,
                        rtpParameters : this._webcamProducer.rtpParameters,
                        codec         : this._webcamProducer.rtpParameters.codecs[0].mimeType.split(
                            "/"
                        )[1],
                    })
                );

                this._webcamProducer.on("transportclose", () => {
                    this._webcamProducer = null;
                });

                this._webcamProducer.on("trackended", () => {
                    // store.dispatch(
                    //     requestActions.notify({
                    //         type: "error",
                    //         text: intl.formatMessage({
                    //             id: "devices.cameraDisconnected",
                    //             defaultMessage: "Camera disconnected",
                    //         }),
                    //     })
                    // );

                    this.disableWebcam();
                });

                store.dispatch(settingsActions.setVideoMuted(false));
            } else if (this._webcamProducer) {
                ({ track } = this._webcamProducer);

                await track.applyConstraints({
                    ...getVideoConstrains(resolution, aspectRatio),
                    frameRate,
                });

                // Also change resolution of extra video producers
                for (const producer of this._extraVideoProducers.values()) {
                    ({ track } = producer);

                    await track.applyConstraints({
                        ...getVideoConstrains(resolution, aspectRatio),
                        frameRate,
                    });
                }
            }

            await this._updateWebcams();
        } catch (error) {
            logger.error('updateWebcam() [error:"%o"]', error);

            // store.dispatch(
            //     requestActions.notify({
            //         type: "error",
            //         text: intl.formatMessage({
            //             id: "devices.cameraError",
            //             defaultMessage:
            //                 "An error occurred while accessing your camera",
            //         }),
            //     })
            // );

            if (track) {
                track.stop();
            }
        }

        store.dispatch(meActions.setWebcamInProgress(false));
    }

    addSelectedPeer(peerId) {
        logger.debug('addSelectedPeer() [peerId:"%s"]', peerId);

        this._spotlights.addPeerToSelectedSpotlights(peerId);

        store.dispatch(roomActions.addSelectedPeer(peerId));
    }

    setSelectedPeer(peerId) {
        logger.debug('setSelectedPeer() [peerId:"%s"]', peerId);

        this.clearSelectedPeers();
        this.addSelectedPeer(peerId);
    }

    removeSelectedPeer(peerId) {
        logger.debug('removeSelectedPeer() [peerId:"%s"]', peerId);

        this._spotlights.removePeerFromSelectedSpotlights(peerId);

        store.dispatch(roomActions.removeSelectedPeer(peerId));
    }

    clearSelectedPeers() {
        logger.debug("clearSelectedPeers()");

        this._spotlights.clearPeersFromSelectedSpotlights();

        store.dispatch(roomActions.clearSelectedPeers());
    }

    async promoteAllLobbyPeers() {
        logger.debug("promoteAllLobbyPeers()");

        store.dispatch(roomActions.setLobbyPeersPromotionInProgress(true));

        try {
            await this.sendRequest("promoteAllPeers");
        } catch (error) {
            logger.error('promoteAllLobbyPeers() [error:"%o"]', error);
        }

        store.dispatch(roomActions.setLobbyPeersPromotionInProgress(false));
    }

    async promoteLobbyPeer(peerId) {
        logger.debug('promoteLobbyPeer() [peerId:"%s"]', peerId);

        store.dispatch(
            lobbyPeerActions.setLobbyPeerPromotionInProgress(peerId, true)
        );

        try {
            await this.sendRequest("promotePeer", { peerId });
        } catch (error) {
            logger.error('promoteLobbyPeer() [error:"%o"]', error);
        }

        store.dispatch(
            lobbyPeerActions.setLobbyPeerPromotionInProgress(peerId, false)
        );
    }

    async clearChat() {
        logger.debug("clearChat()");

        store.dispatch(roomActions.setClearChatInProgress(true));

        try {
            await this.sendRequest("moderator:clearChat");

            store.dispatch(chatActions.clearChat());
        } catch (error) {
            logger.error('clearChat() [error:"%o"]', error);
        }

        store.dispatch(roomActions.setClearChatInProgress(false));
    }

    async clearFileSharing() {
        logger.debug("clearFileSharing()");

        store.dispatch(roomActions.setClearFileSharingInProgress(true));

        try {
            await this.sendRequest("moderator:clearFileSharing");

            store.dispatch(fileActions.clearFiles());
        } catch (error) {
            logger.error('clearFileSharing() [error:"%o"]', error);
        }

        store.dispatch(roomActions.setClearFileSharingInProgress(false));
    }

    async givePeerRole(peerId, roleId) {
        logger.debug(
            'givePeerRole() [peerId:"%s", roleId:"%s"]',
            peerId,
            roleId
        );

        store.dispatch(peerActions.setPeerModifyRolesInProgress(peerId, true));

        try {
            await this.sendRequest("moderator:giveRole", { peerId, roleId });
        } catch (error) {
            logger.error('givePeerRole() [error:"%o"]', error);
        }

        store.dispatch(peerActions.setPeerModifyRolesInProgress(peerId, false));
    }

    async removePeerRole(peerId, roleId) {
        logger.debug(
            'removePeerRole() [peerId:"%s", roleId:"%s"]',
            peerId,
            roleId
        );

        store.dispatch(peerActions.setPeerModifyRolesInProgress(peerId, true));

        try {
            await this.sendRequest("moderator:removeRole", { peerId, roleId });
        } catch (error) {
            logger.error('removePeerRole() [error:"%o"]', error);
        }

        store.dispatch(peerActions.setPeerModifyRolesInProgress(peerId, false));
    }

    async kickPeer(peerId) {
        logger.debug('kickPeer() [peerId:"%s"]', peerId);

        store.dispatch(peerActions.setPeerKickInProgress(peerId, true));

        try {
            await this.sendRequest("moderator:kickPeer", { peerId });
        } catch (error) {
            logger.error('kickPeer() [error:"%o"]', error);
        }

        store.dispatch(peerActions.setPeerKickInProgress(peerId, false));
    }

    async mutePeer(peerId) {
        logger.debug('mutePeer() [peerId:"%s"]', peerId);

        store.dispatch(peerActions.setMutePeerInProgress(peerId, true));

        try {
            await this.sendRequest("moderator:mute", { peerId });
        } catch (error) {
            logger.error('mutePeer() [error:"%o"]', error);
        }

        store.dispatch(peerActions.setMutePeerInProgress(peerId, false));
    }

    async stopPeerVideo(peerId) {
        logger.debug('stopPeerVideo() [peerId:"%s"]', peerId);

        store.dispatch(peerActions.setStopPeerVideoInProgress(peerId, true));

        try {
            await this.sendRequest("moderator:stopVideo", { peerId });
        } catch (error) {
            logger.error('stopPeerVideo() [error:"%o"]', error);
        }

        store.dispatch(peerActions.setStopPeerVideoInProgress(peerId, false));
    }

    async stopPeerScreenSharing(peerId) {
        logger.debug('stopPeerScreenSharing() [peerId:"%s"]', peerId);

        store.dispatch(
            peerActions.setStopPeerScreenSharingInProgress(peerId, true)
        );

        try {
            await this.sendRequest("moderator:stopScreenSharing", { peerId });
        } catch (error) {
            logger.error('stopPeerScreenSharing() [error:"%o"]', error);
        }

        store.dispatch(
            peerActions.setStopPeerScreenSharingInProgress(peerId, false)
        );
    }

    async muteAllPeers() {
        logger.debug("muteAllPeers()");

        store.dispatch(roomActions.setMuteAllInProgress(true));

        try {
            await this.sendRequest("moderator:muteAll");
        } catch (error) {
            logger.error('muteAllPeers() [error:"%o"]', error);
        }

        store.dispatch(roomActions.setMuteAllInProgress(false));
    }

    async stopAllPeerVideo() {
        logger.debug("stopAllPeerVideo()");

        store.dispatch(roomActions.setStopAllVideoInProgress(true));

        try {
            await this.sendRequest("moderator:stopAllVideo");
        } catch (error) {
            logger.error('stopAllPeerVideo() [error:"%o"]', error);
        }

        store.dispatch(roomActions.setStopAllVideoInProgress(false));
    }

    async stopAllPeerScreenSharing() {
        logger.debug("stopAllPeerScreenSharing()");

        store.dispatch(roomActions.setStopAllScreenSharingInProgress(true));

        try {
            await this.sendRequest("moderator:stopAllScreenSharing");
        } catch (error) {
            logger.error('stopAllPeerScreenSharing() [error:"%o"]', error);
        }

        store.dispatch(roomActions.setStopAllScreenSharingInProgress(false));
    }

    async closeMeeting() {
        logger.debug("closeMeeting()");

        store.dispatch(roomActions.setCloseMeetingInProgress(true));

        try {
            await this.sendRequest("moderator:closeMeeting");
        } catch (error) {
            logger.error('closeMeeting() [error:"%o"]', error);
        }

        store.dispatch(roomActions.setCloseMeetingInProgress(false));
    }

    // type: mic/webcam/screen
    // mute: true/false
    async modifyPeerConsumer(peerId, type, mute) {
        logger.debug(
            'modifyPeerConsumer() [peerId:"%s", type:"%s"]',
            peerId,
            type
        );

        if (type === "mic") {
            store.dispatch(peerActions.setPeerAudioInProgress(peerId, true));
        } else if (type === "webcam") {
            store.dispatch(peerActions.setPeerVideoInProgress(peerId, true));
        } else if (type === "screen") {
            store.dispatch(peerActions.setPeerScreenInProgress(peerId, true));
        }

        try {
            for (const consumer of this._consumers.values()) {
                if (
                    consumer.appData.peerId === peerId &&
                    consumer.appData.source === type
                ) {
                    if (mute) {
                        await this._pauseConsumer(consumer);
                    } else {
                        await this._resumeConsumer(consumer);
                    }
                }
            }
        } catch (error) {
            logger.error('modifyPeerConsumer() [error:"%o"]', error);
        }

        if (type === "mic") {
            store.dispatch(peerActions.setPeerAudioInProgress(peerId, false));
        } else if (type === "webcam") {
            store.dispatch(peerActions.setPeerVideoInProgress(peerId, false));
        } else if (type === "screen") {
            store.dispatch(peerActions.setPeerScreenInProgress(peerId, false));
        }
    }
    async setAudioGain(micConsumer, peerId, audioGain) {
        logger.debug(
            'setAudioGain() [micConsumer:"%o", peerId:"%s", type:"%s"]',
            micConsumer,
            peerId,
            audioGain
        );

        if (!micConsumer) {
            return;
        }

        micConsumer.audioGain = audioGain;

        try {
            for (const consumer of this._consumers.values()) {
                if (consumer.appData.peerId === peerId) {
                    store.dispatch(
                        consumerActions.setConsumerAudioGain(
                            consumer.id,
                            audioGain
                        )
                    );
                }
            }
        } catch (error) {
            logger.error('setAudioGain() [error:"%o"]', error);
        }
    }
    async _pauseConsumer(consumer) {
        logger.debug('_pauseConsumer() [consumer:"%o"]', consumer);

        if (consumer.paused || consumer.closed) {
            return;
        }

        try {
            await this.sendRequest("pauseConsumer", {
                consumerId : consumer.id,
            });

            consumer.pause();

            store.dispatch(
                consumerActions.setConsumerPaused(consumer.id, "local")
            );
        } catch (error) {
            logger.error(
                '_pauseConsumer() [consumerId: %s; error:"%o"]',
                consumer.id,
                error
            );
            if (error.notFoundInMediasoupError) {
                this._closeConsumer(consumer.id);
            }
        }
    }

    async _resumeConsumer(consumer) {
        logger.debug('_resumeConsumer() [consumer:"%o"]', consumer);

        if (!consumer.paused || consumer.closed) {
            return;
        }

        try {
            await this.sendRequest("resumeConsumer", {
                consumerId : consumer.id,
            });

            consumer.resume();

            store.dispatch(
                consumerActions.setConsumerResumed(consumer.id, "local")
            );
        } catch (error) {
            logger.error(
                '_resumeConsumer() [consumerId: %s; error:"%o"]',
                consumer.id,
                error
            );
            if (error.notFoundInMediasoupError) {
                this._closeConsumer(consumer.id);
            }
        }
    }

    async _startConsumer(consumer) {
        return this._resumeConsumer(consumer, { initial: true });
    }

    async lowerPeerHand(peerId) {
        logger.debug('lowerPeerHand() [peerId:"%s"]', peerId);

        store.dispatch(peerActions.setPeerRaisedHandInProgress(peerId, true));

        try {
            await this.sendRequest("moderator:lowerHand", { peerId });
        } catch (error) {
            logger.error('lowerPeerHand() [error:"%o"]', error);
        }

        store.dispatch(peerActions.setPeerRaisedHandInProgress(peerId, false));
    }

    async setRaisedHand(raisedHand) {
        logger.debug("setRaisedHand: ", raisedHand);

        store.dispatch(meActions.setRaisedHandInProgress(true));

        try {
            await this.sendRequest("raisedHand", { raisedHand });

            store.dispatch(meActions.setRaisedHand(raisedHand));
        } catch (error) {
            logger.error('setRaisedHand() [error:"%o"]', error);

            // We need to refresh the component for it to render changed state
            store.dispatch(meActions.setRaisedHand(!raisedHand));
        }

        store.dispatch(meActions.setRaisedHandInProgress(false));
    }

    async setMaxSendingSpatialLayer(spatialLayer) {
        logger.debug(
            'setMaxSendingSpatialLayer() [spatialLayer:"%s"]',
            spatialLayer
        );

        try {
            if (this._webcamProducer) {
                await this._webcamProducer.setMaxSpatialLayer(spatialLayer);
            }
            if (this._screenSharingProducer) {
                await this._screenSharingProducer.setMaxSpatialLayer(
                    spatialLayer
                );
            }
        } catch (error) {
            logger.error('setMaxSendingSpatialLayer() [error:"%o"]', error);
        }
    }

    async restartIce(transport, ice, delay) {
        logger.debug(
            "restartIce() [transport:%o ice:%o delay:%d]",
            transport,
            ice,
            delay
        );

        if (!transport) {
            logger.error("restartIce(): missing valid transport object");

            return;
        }

        if (!ice) {
            logger.error("restartIce(): missing valid ice object");

            return;
        }

        clearTimeout(ice.timer);
        ice.timer = setTimeout(async () => {
            try {
                if (ice.restarting) {
                    return;
                }
                ice.restarting = true;

                const iceParameters = await this.sendRequest("restartIce", {
                    transportId : transport.id,
                });

                await transport.restartIce({ iceParameters });
                ice.restarting = false;
                logger.debug("ICE restarted");
            } catch (error) {
                logger.error("restartIce() [failed:%o]", error);

                ice.restarting = false;
                ice.timer = setTimeout(() => {
                    this.restartIce(transport, ice, delay * 2);
                }, delay);
            }
        }, delay);
    }

    setConsumerPreferredLayersMax(consumer) {
        if (consumer.type === "simple") {
            return;
        }

        logger.debug(
            'setConsumerPreferredLayersMax() [consumerId:"%s"]',
            consumer.id
        );

        if (
            consumer.preferredSpatialLayer !== consumer.spatialLayers - 1 ||
            consumer.preferredTemporalLayer !== consumer.temporalLayers - 1
        ) {
            return this.setConsumerPreferredLayers(
                consumer.id,
                consumer.spatialLayers - 1,
                consumer.temporalLayers - 1
            );
        }
    }

    async setConsumerPreferredLayers(consumerId, spatialLayer, temporalLayer) {
        logger.debug(
            'setConsumerPreferredLayers() [consumerId:"%s", spatialLayer:"%s", temporalLayer:"%s"]',
            consumerId,
            spatialLayer,
            temporalLayer
        );

        try {
            await this.sendRequest("setConsumerPreferedLayers", {
                consumerId,
                spatialLayer,
                temporalLayer,
            });

            store.dispatch(
                consumerActions.setConsumerPreferredLayers(
                    consumerId,
                    spatialLayer,
                    temporalLayer
                )
            );
        } catch (error) {
            logger.error(
                'setConsumerPreferredLayers() [consumerId: %s; error:"%o"]',
                consumerId,
                error
            );
            if (error.notFoundInMediasoupError) {
                this._closeConsumer(consumerId);
            }
        }
    }

    adaptConsumerPreferredLayers(consumer, viewportWidth, viewportHeight) {
        if (consumer.type === "simple") {
            return;
        }

        if (!viewportWidth || !viewportHeight) {
            return;
        }

        const {
            id,
            preferredSpatialLayer,
            preferredTemporalLayer,
            width,
            height,
            resolutionScalings,
        } = consumer;
        const adaptiveScalingFactor = Math.min(
            Math.max(window.config.adaptiveScalingFactor || 0.75, 0.5),
            1.0
        );

        logger.debug(
            'adaptConsumerPreferredLayers() [consumerId:"%s", width:"%d", height:"%d" resolutionScalings:[%s] viewportWidth:"%d", viewportHeight:"%d"]',
            consumer.id,
            width,
            height,
            resolutionScalings.join(", "),
            viewportWidth,
            viewportHeight
        );

        let newPreferredSpatialLayer = 0;

        for (let i = 0; i < resolutionScalings.length; i++) {
            const levelWidth =
                (adaptiveScalingFactor * width) / resolutionScalings[i];
            const levelHeight =
                (adaptiveScalingFactor * height) / resolutionScalings[i];

            if (viewportWidth >= levelWidth || viewportHeight >= levelHeight) {
                newPreferredSpatialLayer = i;
            } else {
                break;
            }
        }

        let newPreferredTemporalLayer = consumer.temporalLayers - 1;

        if (newPreferredSpatialLayer === 0 && newPreferredTemporalLayer > 0) {
            const lowestLevelWidth = width / resolutionScalings[0];
            const lowestLevelHeight = height / resolutionScalings[0];

            if (
                viewportWidth < lowestLevelWidth * 0.5 &&
                viewportHeight < lowestLevelHeight * 0.5
            ) {
                newPreferredTemporalLayer -= 1;
            }
            if (
                newPreferredTemporalLayer > 0 &&
                viewportWidth < lowestLevelWidth * 0.25 &&
                viewportHeight < lowestLevelHeight * 0.25
            ) {
                newPreferredTemporalLayer -= 1;
            }
        }

        if (
            preferredSpatialLayer !== newPreferredSpatialLayer ||
            preferredTemporalLayer !== newPreferredTemporalLayer
        ) {
            return this.setConsumerPreferredLayers(
                id,
                newPreferredSpatialLayer,
                newPreferredTemporalLayer
            );
        }
    }

    async setConsumerPriority(consumerId, priority) {
        logger.debug(
            'setConsumerPriority() [consumerId:"%s", priority:%d]',
            consumerId,
            priority
        );

        try {
            await this.sendRequest("setConsumerPriority", {
                consumerId,
                priority,
            });

            store.dispatch(
                consumerActions.setConsumerPriority(consumerId, priority)
            );
        } catch (error) {
            logger.error(
                'setConsumerPriority() [consumerId: %s; error:"%o"]',
                consumerId,
                error
            );
            if (error.notFoundInMediasoupError) {
                this._closeConsumer(consumerId);
            }
        }
    }

    async requestConsumerKeyFrame(consumerId) {
        logger.debug('requestConsumerKeyFrame() [consumerId:"%s"]', consumerId);

        try {
            await this.sendRequest("requestConsumerKeyFrame", { consumerId });
        } catch (error) {
            logger.error(
                'requestConsumerKeyFrame() [consumerId: %s; error:"%o"]',
                consumerId,
                error
            );
            if (error.notFoundInMediasoupError) {
                this._closeConsumer(consumerId);
            }
        }
    }

    async _loadDynamicImports() {
        // ({ default: WebTorrent } = await import(
        //     /* webpackPrefetch: true */
        //     /* webpackChunkName: "webtorrent" */
        //     "webtorrent"
        // ));

        ({ default: saveAs } = await import(
            /* webpackPrefetch: true */
            /* webpackChunkName: "file-saver" */
            "file-saver"
        ));

        ({ default: ScreenShare } = await import(
            /* webpackPrefetch: true */
            /* webpackChunkName: "screensharing" */
            "./ScreenShare"
        ));

        mediasoupClient = await import(
            /* webpackPrefetch: true */
            /* webpackChunkName: "mediasoup" */
            "mediasoup-client"
        );

        ({ default: io } = await import(
            /* webpackPrefetch: true */
            /* webpackChunkName: "socket.io" */
            "socket.io-client"
        ));
    }

    async join({ roomId, joinVideo, joinAudio, anonymouse }) {
        logger.debug("start joining");

        if (!anonymouse) {
            await this.requestPeerInfo({ tk: this._peerTk });
        }

        logger.debug("start clearLocalMedia");

        this.clearLocalSelectedMedia();

        await this._loadDynamicImports();

        this._roomId = roomId;

        store.dispatch(roomActions.setRoomName(this._roomId));

        this._signalingUrl = getSignalingUrl({
            roomId      : this._roomId,
            peerId      : this._peerId,
            roleIds     : this._userInfo.roleIds,
            displayName : this._displayName,
            picture     : this._userInfo.picture,
            email       : this._userInfo.email,
        });

        this._screenSharing = ScreenShare.create(this._device);

        this._signalingSocket = io(this._signalingUrl, {
            withCredentials : true,
            transports      : ["websocket"],
        });

        store.dispatch(roomActions.setRoomState("connecting"));

        this._signalingSocket.on("connect", () => {
            logger.debug('signaling Peer "connect" event');
        });

        this._signalingSocket.on("disconnect", (reason) => {
            logger.warn(
                'signaling Peer "disconnect" event [reason:"%s"]',
                reason
            );

            if (this._closed) {
                return;
            }

            if (reason === "io server disconnect") {
                store.dispatch(
                    requestActions.notify({
                        type : "warning",
                        text : intl.formatMessage({
                            id             : "socket.disconnected",
                            defaultMessage : "You are disconnected",
                        }),
                    })
                );

                this.close();
            }

            store.dispatch(
                requestActions.notify({
                    type : "warning",
                    text : intl.formatMessage({
                        id             : "socket.reconnecting",
                        defaultMessage :
                            "You are disconnected, attempting to reconnect",
                    }),
                })
            );

            if (this._screenSharingProducer) {
                this._screenSharingProducer.close();

                store.dispatch(
                    producerActions.removeProducer(
                        this._screenSharingProducer.id
                    )
                );

                this._screenSharingProducer = null;
            }

            if (this._webcamProducer) {
                this._webcamProducer.close();

                store.dispatch(
                    producerActions.removeProducer(this._webcamProducer.id)
                );

                this._webcamProducer = null;
            }

            for (const producer of this._extraVideoProducers.values()) {
                producer.close();

                store.dispatch(producerActions.removeProducer(producer.id));
            }
            this._extraVideoProducers.clear();

            if (this._micProducer) {
                this._micProducer.close();

                store.dispatch(
                    producerActions.removeProducer(this._micProducer.id)
                );

                this._micProducer = null;
            }

            if (this._sendTransport) {
                this._sendTransport.close();

                this._sendTransport = null;
            }

            if (this._recvTransport) {
                this._recvTransport.close();

                this._recvTransport = null;
            }

            this._spotlights.clearSpotlights();

            this.getYoutubeManager().dispose();

            store.dispatch(peerActions.clearPeers());
            store.dispatch(consumerActions.clearConsumers());
            store.dispatch(roomActions.clearSpotlights());
            // store.dispatch(roomActions.setRoomState("new"));
            store.dispatch(roomActions.clearBreakoutRoom());
            // store.dispatch(roomActions.setDevicePermissionOpen(true));
            store.dispatch(documentActions.setOnlineDocumentOpen(false));
            store.dispatch(roomActions.setEnableEventListenerKeys(true));
        });

        this._signalingSocket.on("reconnect_failed", () => {
            logger.warn('signaling Peer "reconnect_failed" event');

            store.dispatch(
                requestActions.notify({
                    type : "warning",
                    text : intl.formatMessage({
                        id             : "socket.disconnected",
                        defaultMessage : "You are disconnected",
                    }),
                })
            );

            this.close();
        });

        this._signalingSocket.on("reconnect", (attemptNumber) => {
            logger.debug(
                'signaling Peer "reconnect" event [attempts:"%s"]',
                attemptNumber
            );

            store.dispatch(
                requestActions.notify({
                    type : "warning",
                    text : intl.formatMessage({
                        id             : "socket.reconnected",
                        defaultMessage : "You are reconnected",
                    }),
                })
            );

            store.dispatch(roomActions.setRoomState("connected"));
        });

        this._signalingSocket.on("room-message", async (serverMessage) => {
            logger.debug(
                'Socket server signaling on "room-message" [Message: %o]',
                serverMessage
            );

            try {
                switch (serverMessage.method) {
                case "api":
                    const { message } = serverMessage.data;
                    window.alert(message);
                    break;
                case "query":
                    break;
                case "error":
                    break;
                case "multipleDevices":
                    break;
                default:
                    logger.error(
                        'unknown serverMessage.method "%s"',
                        serverMessage.method
                    );
                    break;
                }
            } catch (error) {
                logger.error('Error on server message "%s"', error);
                // store.dispatch(
                //     requestActions.notify({
                //         type: "error",
                //         text: intl.formatMessage({
                //             id: "socket.requestError",
                //             defaultMessage: "Error on server request",
                //         }),
                //     })
                // );
            }
        });

        this._signalingSocket.on("notification", async (notification) => {
            try {
                logger.debug("notification [method: %s]", notification.method);

                switch (notification.method) {
                case "newConsumer": {
                    const {
                        peerId,
                        producerId,
                        id,
                        kind,
                        rtpParameters,
                        type,
                        appData,
                        producerPaused,
                    } = notification.data;

                    const consumer = await this._recvTransport.consume({
                        id,
                        producerId,
                        kind,
                        rtpParameters,
                        appData : { ...appData, peerId }, // Trick.
                    });

                    if (
                        this._recvTransport.appData.encodedInsertableStreams
                    ) {
                        const { enableOpusDetails } =
                                store.getState().settings;

                        if (kind === "audio" && enableOpusDetails)
                        {opusReceiverTransform(
                            consumer.rtpReceiver,
                            consumer.id
                        );}
                        else {directReceiverTransform(consumer.rtpReceiver);}
                    }

                    // Store in the map.
                    this._consumers.set(consumer.id, consumer);

                    consumer.on("transportclose", () => {
                        this._consumers.delete(consumer.id);
                    });

                    const { spatialLayers, temporalLayers } =
                            mediasoupClient.parseScalabilityMode(
                                consumer.rtpParameters.encodings[0]
                                    .scalabilityMode
                            );

                    const consumerStoreObject = {
                        id                 : consumer.id,
                        peerId,
                        kind,
                        type,
                        locallyPaused      : false,
                        remotelyPaused     : producerPaused,
                        rtpParameters      : consumer.rtpParameters,
                        source             : consumer.appData.source,
                        width              : consumer.appData.width,
                        height             : consumer.appData.height,
                        resolutionScalings :
                                consumer.appData.resolutionScalings,
                        spatialLayers,
                        temporalLayers,
                        preferredSpatialLayer  : 0,
                        preferredTemporalLayer : 0,
                        priority               : 1,
                        codec                  : consumer.rtpParameters.codecs[0].mimeType.split(
                            "/"
                        )[1],
                        track      : consumer.track,
                        audioGain  : undefined,
                        opusConfig : null,
                    };

                    this._spotlights.addVideoConsumer(consumerStoreObject);

                    store.dispatch(
                        consumerActions.addConsumer(
                            consumerStoreObject,
                            peerId
                        )
                    );

                    await this._startConsumer(consumer);

                    // // We are ready. Answer the request so the server will
                    // // resume this Consumer (which was paused for now).
                    // cb(null);

                    if (kind === "audio") {
                        consumer.volume = 0;

                        const stream = new MediaStream();

                        stream.addTrack(consumer.track);

                        if (!stream.getAudioTracks()[0]) {
                            throw new Error(
                                "request.newConsumer | given stream has no audio track"
                            );
                        }

                        consumer.hark = hark(stream, { play: false });

                        consumer.hark.on("volume_change", (volume) => {
                            volume = Math.round(volume);

                            if (consumer && volume !== consumer.volume) {
                                consumer.volume = volume;

                                store.dispatch(
                                    peerVolumeActions.setPeerVolume(
                                        peerId,
                                        volume
                                    )
                                );
                            }
                        });
                    }

                    break;
                }

                // case "holding": {
                //     const { displayName, id } = notification.data;

                //     store.dispatch(roomActions.setInLobby(false));

                //     store.dispatch(roomActions.toggleJoined());
                //     store.dispatch(
                //         settingsActions.setDisplayName(displayName)
                //     );
                //     store.dispatch(meActions.setMe({ peerId: id }));

                //     store.dispatch(roomActions.setRoomState("connected"));

                //     break;
                // }

                case "roomBack": {
                    await this._joinRoom({
                        joinVideo,
                        joinAudio,
                        returning : true,
                    });

                    break;
                }

                case "roomReady": {
                    const { turnServers } = notification.data;

                    this._turnServers = turnServers;

                    store.dispatch(roomActions.toggleJoined());
                    store.dispatch(roomActions.setInLobby(false));

                    await this._joinRoom({ joinVideo, joinAudio });

                    break;
                }

                case "parkedPeer": {
                    const { peerId, displayName, picture } =
                            notification.data;

                    store.dispatch(lobbyPeerActions.addLobbyPeer(peerId));
                    store.dispatch(roomActions.setToolbarsVisible(true));

                    store.dispatch(
                        lobbyPeerActions.setLobbyPeerDisplayName(
                            displayName,
                            peerId
                        )
                    );

                    store.dispatch(
                        lobbyPeerActions.setLobbyPeerPicture(
                            picture,
                            peerId
                        )
                    );

                    this._soundNotification();

                    store.dispatch(
                        requestActions.notify({
                            type : "warning",
                            text : intl.formatMessage({
                                id             : "room.newLobbyPeer",
                                defaultMessage :
                                        "New participant entered the lobby",
                            }),
                        })
                    );

                    break;
                }

                case "parkedPeers": {
                    const { lobbyPeers } = notification.data;

                    if (lobbyPeers.length > 0) {
                        lobbyPeers.forEach((peer) => {
                            store.dispatch(
                                lobbyPeerActions.addLobbyPeer(peer.id)
                            );

                            store.dispatch(
                                lobbyPeerActions.setLobbyPeerDisplayName(
                                    peer.displayName,
                                    peer.id
                                )
                            );

                            store.dispatch(
                                lobbyPeerActions.setLobbyPeerPicture(
                                    peer.picture,
                                    peer.id
                                )
                            );
                        });

                        store.dispatch(
                            roomActions.setToolbarsVisible(true)
                        );

                        this._soundNotification();

                        store.dispatch(
                            requestActions.notify({
                                type : "warning",
                                text : intl.formatMessage({
                                    id             : "room.newLobbyPeer",
                                    defaultMessage :
                                            "New participant entered the lobby",
                                }),
                            })
                        );
                    }

                    break;
                }

                case "lockRoom": {
                    store.dispatch(roomActions.setRoomLocked());

                    store.dispatch(
                        requestActions.notify({
                            text : intl.formatMessage({
                                id             : "room.locked",
                                defaultMessage : "Room is now locked",
                            }),
                        })
                    );

                    break;
                }

                case "unlockRoom": {
                    store.dispatch(roomActions.setRoomUnLocked());

                    store.dispatch(
                        requestActions.notify({
                            type : "default",
                            text : intl.formatMessage({
                                id             : "room.unlocked",
                                defaultMessage : "Room is now unlocked",
                            }),
                        })
                    );

                    break;
                }

                case "enteredLobby": {
                    store.dispatch(roomActions.setInLobby(true));
                    store.dispatch(roomActions.setRoomState("connected"));

                    break;
                }

                case "lobby:promotedPeer": {
                    const { peerId } = notification.data;

                    store.dispatch(
                        lobbyPeerActions.removeLobbyPeer(peerId)
                    );

                    break;
                }

                case "lobby:peerClosed": {
                    const { peerId } = notification.data;

                    store.dispatch(
                        lobbyPeerActions.removeLobbyPeer(peerId)
                    );

                    store.dispatch(
                        requestActions.notify({
                            type : "warning",
                            text : intl.formatMessage({
                                id             : "room.lobbyPeerLeft",
                                defaultMessage : "Participant in lobby left",
                            }),
                        })
                    );

                    break;
                }

                case "overRoomLimit": {
                    store.dispatch(roomActions.setOverRoomLimit(true));
                    break;
                }
                case "signInRequired": {
                    store.dispatch(roomActions.setSignInRequired(true));

                    break;
                }

                case "parkedPeer": {
                    const { peerId, displayName } = notification.data;

                    store.dispatch(lobbyPeerActions.addLobbyPeer(peerId));
                    store.dispatch(roomActions.setToolbarsVisible(true));

                    store.dispatch(
                        lobbyPeerActions.setLobbyPeerDisplayName(
                            displayName,
                            peerId
                        )
                    );

                    this._soundNotification();

                    store.dispatch(
                        requestActions.notify({
                            type : "warning",
                            text : intl.formatMessage({
                                id             : "room.newLobbyPeer",
                                defaultMessage :
                                        "New participant entered the lobby",
                            }),
                        })
                    );

                    break;
                }

                case "parkedPeers": {
                    const { lobbyPeers } = notification.data;

                    if (lobbyPeers.length > 0) {
                        lobbyPeers.forEach((peer) => {
                            store.dispatch(
                                lobbyPeerActions.addLobbyPeer(peer.id)
                            );

                            store.dispatch(
                                lobbyPeerActions.setLobbyPeerDisplayName(
                                    peer.displayName,
                                    peer.id
                                )
                            );

                            store.dispatch(
                                lobbyPeerActions.setLobbyPeerPicture(
                                    peer.picture,
                                    peer.id
                                )
                            );
                        });

                        store.dispatch(
                            roomActions.setToolbarsVisible(true)
                        );

                        this._soundNotification();

                        store.dispatch(
                            requestActions.notify({
                                type : "warning",
                                text : intl.formatMessage({
                                    id             : "room.newLobbyPeer",
                                    defaultMessage :
                                            "New participant entered the lobby",
                                }),
                            })
                        );
                    }

                    break;
                }

                case "lobby:peerClosed": {
                    const { peerId } = notification.data;

                    store.dispatch(
                        lobbyPeerActions.removeLobbyPeer(peerId)
                    );

                    store.dispatch(
                        requestActions.notify({
                            text : intl.formatMessage({
                                type           : "warning",
                                id             : "room.lobbyPeerLeft",
                                defaultMessage : "Participant in lobby left",
                            }),
                        })
                    );

                    break;
                }
                case "lobby:changeDisplayName": {
                    const { peerId, displayName } = notification.data;

                    store.dispatch(
                        lobbyPeerActions.setLobbyPeerDisplayName(
                            displayName,
                            peerId
                        )
                    );

                    store.dispatch(
                        requestActions.notify({
                            type : "warning",
                            text : intl.formatMessage(
                                {
                                    id             : "room.lobbyPeerChangedDisplayName",
                                    defaultMessage :
                                            "Participant in lobby changed name to {displayName}",
                                },
                                {
                                    displayName,
                                }
                            ),
                        })
                    );

                    break;
                }

                case "lobby:changePicture": {
                    const { peerId, picture } = notification.data;

                    store.dispatch(
                        lobbyPeerActions.setLobbyPeerPicture(
                            picture,
                            peerId
                        )
                    );

                    store.dispatch(
                        requestActions.notify({
                            type : "warning",
                            text : intl.formatMessage({
                                id             : "room.lobbyPeerChangedPicture",
                                defaultMessage :
                                        "Participant in lobby changed picture",
                            }),
                        })
                    );

                    break;
                }

                case "setAccessCode": {
                    const { accessCode } = notification.data;

                    store.dispatch(roomActions.setAccessCode(accessCode));

                    store.dispatch(
                        requestActions.notify({
                            type : "default",
                            text : intl.formatMessage({
                                id             : "room.setAccessCode",
                                defaultMessage :
                                        "Access code for room updated",
                            }),
                        })
                    );

                    break;
                }

                case "setJoinByAccessCode": {
                    const { joinByAccessCode } = notification.data;

                    store.dispatch(
                        roomActions.setJoinByAccessCode(joinByAccessCode)
                    );

                    if (joinByAccessCode) {
                        store.dispatch(
                            requestActions.notify({
                                type : "warning",
                                text : intl.formatMessage({
                                    id             : "room.accessCodeOn",
                                    defaultMessage :
                                            "Access code for room is now activated",
                                }),
                            })
                        );
                    } else {
                        store.dispatch(
                            requestActions.notify({
                                type : "warning",
                                text : intl.formatMessage({
                                    id             : "room.accessCodeOff",
                                    defaultMessage :
                                            "Access code for room is now deactivated",
                                }),
                            })
                        );
                    }

                    break;
                }

                case "activeSpeaker": {
                    // const { peerId } = notification.data;

                    // store.dispatch(roomActions.setRoomActiveSpeaker(peerId));

                    // if (peerId && peerId !== this._peerId)
                    //   this._spotlights.handleActiveSpeaker(peerId);

                    break;
                }

                case "changeDisplayName": {
                    const { peerId, displayName, oldDisplayName } =
                            notification.data;

                    store.dispatch(
                        peerActions.setPeerDisplayName(displayName, peerId)
                    );

                    store.dispatch(
                        requestActions.notify({
                            type : "info",
                            text : intl.formatMessage(
                                {
                                    id             : "room.peerChangedDisplayName",
                                    defaultMessage :
                                            "{oldDisplayName} is now {displayName}",
                                },
                                {
                                    oldDisplayName,
                                    displayName,
                                }
                            ),
                        })
                    );

                    break;
                }

                case "changePicture": {
                    const { peerId, picture } = notification.data;

                    store.dispatch(
                        peerActions.setPeerPicture(peerId, picture)
                    );

                    break;
                }

                case "raisedHand": {
                    const { peerId, raisedHand, raisedHandTimestamp } =
                            notification.data;

                    store.dispatch(
                        peerActions.setPeerRaisedHand(
                            peerId,
                            raisedHand,
                            raisedHandTimestamp
                        )
                    );

                    // const { displayName } = store.getState().peers[peerId];

                    if (raisedHand) {
                        // text = intl.formatMessage(
                        //     {
                        //         id: "room.raisedHand",
                        //         defaultMessage:
                        //             "{displayName} raised their hand",
                        //     },
                        //     {
                        //         displayName,
                        //     }
                        // );
                        this._spotlights.addPeerToSelectedSpotlights(
                            peerId
                        );
                    } else {
                        // text = intl.formatMessage(
                        //     {
                        //         id: "room.loweredHand",
                        //         defaultMessage:
                        //             "{displayName} put their hand down",
                        //     },
                        //     {
                        //         displayName,
                        //     }
                        // );
                        this._spotlights.removePeerFromSelectedSpotlights(
                            peerId
                        );
                    }

                    // if (displayName) {
                    //     store.dispatch(
                    //         requestActions.notify({
                    //             text,
                    //         })
                    //     );
                    // }

                    this._soundNotification(notification.method);

                    break;
                }

                case "chatMessage": {
                    const { peerId, chatMessage } = notification.data;

                    store.dispatch(
                        chatActions.addMessage({
                            ...chatMessage,
                            peerId,
                            isRead : false,
                        })
                    );

                    if (
                        !store.getState().toolarea.toolAreaOpen ||
                            (store.getState().toolarea.toolAreaOpen &&
                                store.getState().toolarea.currentToolTab !==
                                    "chat")
                    ) {
                        // Make sound
                        store.dispatch(
                            roomActions.setToolbarsVisible(true)
                        );
                        this._soundNotification(notification.method);
                    }

                    break;
                }

                case "moderator:clearChat": {
                    store.dispatch(chatActions.clearChat());
                    store.dispatch(fileActions.clearFiles());

                    // store.dispatch(
                    //     requestActions.notify({
                    //         text: intl.formatMessage({
                    //             id: "moderator.clearChat",
                    //             defaultMessage:
                    //                 "Moderator cleared the chat",
                    //         }),
                    //     })
                    // );

                    break;
                }

                case "sendFile": {
                    const file = notification.data;

                    store.dispatch(fileActions.addFile({ ...file }));

                    // store.dispatch(
                    //     requestActions.notify({
                    //         text: intl.formatMessage({
                    //             id: "room.newFile",
                    //             defaultMessage: "New file available",
                    //         }),
                    //     })
                    // );

                    if (
                        !store.getState().toolarea.toolAreaOpen ||
                            (store.getState().toolarea.toolAreaOpen &&
                                store.getState().toolarea.currentToolTab !==
                                    "chat")
                    ) {
                        // Make sound
                        store.dispatch(
                            roomActions.setToolbarsVisible(true)
                        );
                        this._soundNotification(notification.method);
                    }

                    break;
                }

                // case "moderator:clearFileSharing": {
                //   store.dispatch(fileActions.clearFiles());

                //   store.dispatch(
                //     requestActions.notify({
                //       text: intl.formatMessage({
                //         id: "moderator.clearFiles",
                //         defaultMessage: "Moderator cleared the files",
                //       }),
                //     })
                //   );

                //   break;
                // }

                case "producerScore": {
                    const { producerId, score } = notification.data;

                    store.dispatch(
                        producerActions.setProducerScore(producerId, score)
                    );

                    break;
                }

                case "newPeer": {
                    const { id, displayName, picture, roles, returning } =
                            notification.data;

                    store.dispatch(
                        peerActions.addPeer({
                            id,
                            displayName,
                            picture,
                            roles,
                            consumers : [],
                        })
                    );

                    this._spotlights.newPeer(id);

                    if (!returning) {
                        this._soundNotification(notification.method);

                        store.dispatch(
                            requestActions.notify({
                                type : "info",
                                text : intl.formatMessage(
                                    {
                                        id             : "room.newPeer",
                                        defaultMessage :
                                                "{displayName} joined the room",
                                    },
                                    {
                                        displayName,
                                    }
                                ),
                            })
                        );
                    }

                    break;
                }

                case "peerClosed": {
                    const { peerId } = notification.data;

                    for (const consumer of this._consumers.values()) {
                        if (peerId === consumer.appData.peerId) {
                            this._closeConsumer(consumer.id);
                        }
                    }

                    this._spotlights.closePeer(peerId);

                    store.dispatch(peerActions.removePeer(peerId));

                    const peers = store.getState().peers;

                    if (Array.from(peers).length < 1) {
                        store.dispatch(
                            roomActions.setDisplayMode("democratic")
                        );
                    }

                    break;
                }

                case "consumerClosed": {
                    const { consumerId } = notification.data;

                    this._closeConsumer(consumerId);

                    break;
                }

                case "consumerPaused": {
                    const { consumerId } = notification.data;
                    const consumer = this._consumers.get(consumerId);

                    if (!consumer) {
                        break;
                    }

                    store.dispatch(
                        consumerActions.setConsumerPaused(
                            consumerId,
                            "remote"
                        )
                    );

                    this._spotlights.pauseVideoConsumer(consumerId);

                    break;
                }

                case "consumerResumed": {
                    const { consumerId } = notification.data;
                    const consumer = this._consumers.get(consumerId);

                    if (!consumer) {
                        break;
                    }

                    store.dispatch(
                        consumerActions.setConsumerResumed(
                            consumerId,
                            "remote"
                        )
                    );

                    break;
                }

                case "consumerLayersChanged": {
                    const { consumerId, spatialLayer, temporalLayer } =
                            notification.data;
                    const consumer = this._consumers.get(consumerId);

                    if (!consumer) {
                        break;
                    }

                    store.dispatch(
                        consumerActions.setConsumerCurrentLayers(
                            consumerId,
                            spatialLayer,
                            temporalLayer
                        )
                    );

                    break;
                }

                case "consumerScore": {
                    const { consumerId, score } = notification.data;

                    store.dispatch(
                        consumerActions.setConsumerScore(consumerId, score)
                    );

                    break;
                }

                case "moderator:mute": {
                    if (this._micProducer && !this._micProducer.paused) {
                        this.muteMic();

                        // store.dispatch(
                        //     requestActions.notify({
                        //         text: intl.formatMessage({
                        //             id: "moderator.muteAudio",
                        //             defaultMessage:
                        //                 "Moderator muted your audio",
                        //         }),
                        //     })
                        // );
                    }

                    break;
                }

                case "moderator:stopVideo": {
                    this.disableWebcam();

                    // store.dispatch(
                    //     requestActions.notify({
                    //         text: intl.formatMessage({
                    //             id: "moderator.muteVideo",
                    //             defaultMessage:
                    //                 "Moderator stopped your video",
                    //         }),
                    //     })
                    // );

                    break;
                }

                case "moderator:stopScreenSharing": {
                    this.disableScreenSharing();

                    // store.dispatch(
                    //     requestActions.notify({
                    //         text: intl.formatMessage({
                    //             id: "moderator.stopScreenSharing",
                    //             defaultMessage:
                    //                 "Moderator stopped your screen sharing",
                    //         }),
                    //     })
                    // );

                    break;
                }

                case "moderator:kick": {
                    // Need some feedback
                    this.close();

                    break;
                }

                case "moderator:lowerHand": {
                    this.setRaisedHand(false);

                    break;
                }

                case "gotRole": {
                    const { peerId, roleId } = notification.data;

                    const userRoles = store.getState().room.userRoles;

                    if (peerId == this._peerId) {
                        store.dispatch(meActions.addRole(roleId));

                        store.dispatch(
                            requestActions.notify({
                                type : "default",
                                text : intl.formatMessage(
                                    {
                                        id             : "roles.gotRole",
                                        defaultMessage :
                                                "You got the role: {role}",
                                    },
                                    {
                                        role : userRoles.get(roleId).label,
                                    }
                                ),
                            })
                        );
                    } else {
                        store.dispatch(
                            peerActions.addPeerRole(peerId, roleId)
                        );
                    }

                    break;
                }

                case "lostRole": {
                    const { peerId, roleId } = notification.data;

                    const userRoles = store.getState().room.userRoles;

                    if (peerId == this._peerId) {
                        store.dispatch(meActions.removeRole(roleId));

                        store.dispatch(
                            requestActions.notify({
                                type : "default",
                                text : intl.formatMessage(
                                    {
                                        id             : "roles.lostRole",
                                        defaultMessage :
                                                "You lost the role: {role}",
                                    },
                                    {
                                        role : userRoles.get(roleId).label,
                                    }
                                ),
                            })
                        );
                    } else {
                        store.dispatch(
                            peerActions.removePeerRole(peerId, roleId)
                        );
                    }

                    break;
                }

                case "moderator:recording": {
                    const { peerId, recordingState } = notification.data;
                    const { me, peers } = store.getState();

                    let displayNameOfRecorder;

                    if (peerId === me.id) {
                        displayNameOfRecorder =
                                store.getState().settings.displayName;
                    } else if (peers[peerId]) {
                        displayNameOfRecorder =
                                store.getState().peers[peerId].displayName;
                    } else {
                        return;
                    }

                    // Save state to peer
                    store.dispatch(
                        peerActions.setPeerRecordingState(
                            peerId,
                            recordingState
                        )
                    );

                    switch (recordingState) {
                    case RECORDING_START:
                        store.dispatch(
                            roomActions.setRecordingState(
                                recordingState
                            )
                        );
                        store.dispatch(
                            requestActions.notify({
                                type : "error",
                                text : intl.formatMessage(
                                    {
                                        id             : "room.recordingStarted",
                                        defaultMessage :
                                                    "{displayName} started recording",
                                    },
                                    {
                                        displayName :
                                                    displayNameOfRecorder,
                                    }
                                ),
                            })
                        );
                        break;
                    case RECORDING_RESUME:
                        store.dispatch(
                            roomActions.setRecordingState(
                                recordingState
                            )
                        );
                        store.dispatch(
                            requestActions.notify({
                                type : "error",
                                text : intl.formatMessage(
                                    {
                                        id             : "room.recordingResumed",
                                        defaultMessage :
                                                    "{displayName} resumed recording",
                                    },
                                    {
                                        displayName :
                                                    displayNameOfRecorder,
                                    }
                                ),
                            })
                        );
                        break;
                    case RECORDING_PAUSE:
                        store.dispatch(
                            roomActions.setRecordingState(
                                recordingState
                            )
                        );
                        store.dispatch(
                            requestActions.notify({
                                type : "error",
                                text : intl.formatMessage(
                                    {
                                        id             : "room.recordingPaused",
                                        defaultMessage :
                                                    "{displayName} paused recording",
                                    },
                                    {
                                        displayName :
                                                    displayNameOfRecorder,
                                    }
                                ),
                            })
                        );
                        break;
                    case RECORDING_STOP:
                        store.dispatch(
                            roomActions.setRecordingState(
                                recordingState
                            )
                        );
                        // store.dispatch(
                        //     requestActions.notify({
                        //         type: "error",
                        //         text: intl.formatMessage(
                        //             {
                        //                 id: "room.recordingStopped",
                        //                 defaultMessage:
                        //                     "{displayName} stopped recording",
                        //             },
                        //             {
                        //                 displayName:
                        //                     displayNameOfRecorder,
                        //             }
                        //         ),
                        //     })
                        // );
                        break;
                    default:
                        break;
                    }
                    break;
                }

                case "classDocument": {
                    const { method } = notification.data;

                    logger.debug(
                        "classDocument [method: %s] notification: %o",
                        method,
                        notification.data
                    );

                    switch (method) {
                    case "open": {
                        store.dispatch(
                            documentActions.setOnlineDocumentOpen(true)
                        );
                        store.dispatch(
                            roomActions.setEnableEventListenerKeys(
                                false
                            )
                        );
                        break;
                    }
                    case "load": {
                        const { delta } = notification.data;
                        this.getClassDocumentManager().setContents(
                            delta
                        );
                        this.getClassDocumentManager().enable();
                        break;
                    }
                    case "text-change": {
                        const { delta } = notification.data;
                        this.getClassDocumentManager().updateQuill(
                            delta
                        );
                        break;
                    }

                    case "selection-change": {
                        const { range, peer } = notification.data;

                        this.getClassDocumentManager().moveCursor(
                            peer,
                            range
                        );
                        break;
                    }

                    case "close":
                        const { peerId } = notification.data;

                        store.dispatch(
                            roomActions.setEnableEventListenerKeys(true)
                        );
                        this.getClassDocumentManager().removeCursor(
                            peerId
                        );
                        break;
                    default:
                        break;
                    }
                    break;
                }

                case "whiteboard": {
                    const { method } = notification.data;

                    switch (method) {
                    case "open": {
                        store.dispatch(
                            whiteboardActions.setWhiteboardOpen(true)
                        );
                        store.dispatch(
                            roomActions.setEnableEventListenerKeys(
                                false
                            )
                        );
                        break;
                    }
                    case "close":
                        store.dispatch(
                            whiteboardActions.setWhiteboardOpen(false)
                        );
                        store.dispatch(
                            roomActions.setEnableEventListenerKeys(true)
                        );
                        break;
                    default:
                        break;
                    }
                    break;
                }

                case "youtube": {
                    const { method, data } = notification.data;
                    if (data?.currentTime) {
                        this.getYoutubeManager().seek(data.currentTime);
                    }

                    switch (method) {
                    case "start":
                        this.getYoutubeManager().StartSharingYoutubeVideo(
                            data.youtubeUrl,
                            data.ownerId
                        );
                        break;
                    case "playing":
                        this.getYoutubeManager().play();
                        break;
                    case "pause":
                        this.getYoutubeManager().pause();
                        break;
                    case "buffering":
                        this.getYoutubeManager().seek(data.currentTime);
                        break;
                    case "volume":
                        if (data.muted) {
                            this.getYoutubeManager().mute();
                        } else {
                            this.getYoutubeManager().unMute();
                        }
                        this.getYoutubeManager().volume(data.volume);
                        break;
                    case "close":
                        this.getYoutubeManager().dispose();
                        break;
                    case "progress":
                        break;
                    default:
                        logger.error("Unknown method requested");
                        break;
                    }
                    break;
                }

                case "pin": {
                    const { peerId } = notification.data;

                    if (store.getState().room.mode !== "filmstrip") {
                        store.dispatch(
                            roomActions.setDisplayMode("filmstrip")
                        );
                    }

                    this.setSelectedPeer(peerId);

                    break;
                }

                case "unpin": {
                    const { peerId } = notification.data;

                    this.removeSelectedPeer(peerId);

                    break;
                }

                case "breakoutRooms": {
                    const { method, data } = notification.data;

                    switch (method) {
                    case "addBreakoutRooms": {
                        store.dispatch(
                            roomActions.addBreakoutRoom(data)
                        );
                        break;
                    }
                    case "removeBreakoutRooms": {
                        store.dispatch(
                            roomActions.removeBreakoutRoom(data)
                        );
                        break;
                    }

                    case "joinBreakoutRoom": {
                        const {
                            breakoutRoomId,
                            otherPeers,
                            chatHistory,
                            fileHistory,
                            lastNHistory,
                            quizHistory,
                            currentYoutubeLink,
                        } = data;

                        // clear room states before join
                        this.clear();

                        chatHistory.length > 0 &&
                                    store.dispatch(
                                        chatActions.addChatHistory(chatHistory)
                                    );

                        fileHistory.length > 0 &&
                                    store.dispatch(
                                        fileActions.addFileHistory(fileHistory)
                                    );

                        quizHistory.length > 0 &&
                                    store.dispatch(
                                        quizActions.addQuizHistory(quizHistory)
                                    );

                        if (currentYoutubeLink) {
                            this.getYoutubeManager().addYoutubeLink(
                                currentYoutubeLink.url,
                                currentYoutubeLink.ownerId,
                                currentYoutubeLink.progress,
                                currentYoutubeLink.status
                            );
                        }

                        store.dispatch(roomActions.setGroupMode(true));

                        store.dispatch(
                            roomActions.setCurrentJoiningBreakoutRoom(
                                breakoutRoomId
                            )
                        );

                        for (const peer of otherPeers) {
                            store.dispatch(
                                peerActions.addPeer({
                                    ...peer,
                                    consumers : [],
                                })
                            );
                        }

                        store.dispatch(
                            roomActions.setDevicePermissionOpen(false)
                        );
                        store.dispatch(
                            roomActions.setPreJoinBreakoutRoom(false)
                        );

                        const mediaPerms =
                                    store.getState().settings.mediaPerms;

                        if (
                            mediaPerms.video &&
                                    this._havePermission(
                                        permissions.SHARE_VIDEO
                                    )
                        ) {
                            this.updateWebcam({ start: true });
                        } else {
                            this.disableWebcam();
                        }

                        if (
                            mediaPerms.audio &&
                                    this._mediasoupDevice.canProduce("audio") &&
                                    this._havePermission(
                                        permissions.SHARE_AUDIO
                                    )
                        ) {
                            await this.updateMic({ start: true });

                            let autoMuteThreshold = 4;

                            if ("autoMuteThreshold" in window.config) {
                                autoMuteThreshold =
                                            window.config.autoMuteThreshold;
                            }
                            if (
                                autoMuteThreshold &&
                                        otherPeers.length >= autoMuteThreshold
                            ) {
                                this.muteMic();
                            }
                        } else {
                            this.disableMic();
                        }

                        if (lastNHistory.length > 0) {
                            logger.debug(
                                "_joinRoom() | got lastN history"
                            );

                            this._spotlights.addSpeakerList(
                                lastNHistory.filter(
                                    (peerId) => peerId !== this._peerId
                                )
                            );
                        }

                        break;
                    }

                    case "peerJoinedBreakoutRoom": {
                        const { breakoutRoomId, joinedPeer } = data;

                        store.dispatch(
                            roomActions.addPeerToBreakoutRoom(
                                breakoutRoomId,
                                joinedPeer
                            )
                        );
                        //Todo: produce streams

                        break;
                    }

                    case "main:peerJoinedBreakoutRoom": {
                        const { breakoutRoomId, joinedPeer } = data;

                        for (const consumer of this._consumers.values()) {
                            if (
                                joinedPeer.id ===
                                        consumer.appData.peerId
                            ) {
                                this._closeConsumer(consumer.id);
                            }
                        }
                        this._spotlights.closePeer(joinedPeer.id);

                        store.dispatch(
                            peerActions.removePeer(joinedPeer.id)
                        );

                        store.dispatch(
                            roomActions.addPeerToBreakoutRoom(
                                breakoutRoomId,
                                joinedPeer
                            )
                        );
                        break;
                    }

                    //level: Self update
                    case "leaveBreakoutRoom": {
                        store.dispatch(roomActions.setGroupMode(false));
                        store.dispatch(
                            roomActions.setCurrentJoiningBreakoutRoom(
                                null
                            )
                        );

                        store.dispatch(peerActions.clearPeers());

                        // Clear Sportlights
                        this._spotlights.clearSpotlights();

                        store.dispatch(roomActions.clearSpotlights());

                        store.dispatch(
                            roomActions.setDevicePermissionOpen(true)
                        );

                        this.getYoutubeManager().dispose();

                        break;
                    }

                    //level: otherPeer in breakout room update
                    case "peerLeavedBreakoutRoom": {
                        const { breakoutRoomId, peerId } = data;

                        for (const consumer of this._consumers.values()) {
                            if (peerId === consumer.appData.peerId) {
                                this._closeConsumer(consumer.id);
                            }
                        }

                        this._spotlights.closePeer(peerId);

                        store.dispatch(peerActions.removePeer(peerId));

                        store.dispatch(
                            roomActions.removePeerFromBreakoutRoom(
                                breakoutRoomId,
                                peerId
                            )
                        );
                        break;
                    }

                    //level: otherPeer in "main" room update
                    case "main:peerLeavedBreakoutRoom": {
                        const { breakoutRoomId, peerId } = data;
                        store.dispatch(
                            roomActions.removePeerFromBreakoutRoom(
                                breakoutRoomId,
                                peerId
                            )
                        );
                        break;
                    }

                    default:
                        logger.error("Unknown method requested");
                        break;
                    }
                    break;
                }

                case "quiz": {
                    const { method, data } = notification.data;

                    switch (method) {
                    case "sendQuiz": {
                        logger.debug('sendQuiz "%o"', data);

                        const { quiz } = data;

                        store.dispatch(
                            quizActions.addQuiz({
                                ...quiz,
                                answered        : false,
                                peerAnswerIndex : null,
                            })
                        );
                        break;
                    }

                    case "peerSubmitQuiz": {
                        logger.debug('peerSubmitQuiz "%o"', data);

                        const { time, peer } = data;

                        store.dispatch(
                            quizActions.addPeerSubmitQuiz(time, peer)
                        );
                        break;
                    }

                    case "publicQuizResult": {
                        logger.debug('publicQuizResult "%o"', data);

                        const {
                            time,
                            correctIndexs,
                            maxAnsweredPeers,
                            answeredPeers,
                        } = data;

                        store.dispatch(
                            quizActions.updateQuiz({
                                time,
                                correctIndexs,
                                maxAnsweredPeers,
                                answeredPeers,
                                isPublicResult : true,
                            })
                        );

                        break;
                    }
                    default:
                        logger.error("Unknown method requested");
                        break;
                    }
                    break;
                }

                case "presentFile": {
                    const { method, data } = notification.data;

                    logger.debug(
                        "presentFile notification method: %s, data: %o",
                        method,
                        data
                    );

                    switch (method) {
                    case "open": {
                        const { time, pageNumber } = data;

                        const { files } = store.getState().files;

                        const selectedFile = files.filter(
                            (file) => file.time === time
                        )[0];

                        this._presentFile({
                            peerId   : selectedFile.peerId,
                            name     : selectedFile.name,
                            picture  : selectedFile.picture,
                            url      : selectedFile.url,
                            fileType : selectedFile.fileType,
                            fileName : selectedFile.fileName,
                            time     : selectedFile.time,
                            pageNumber,
                        });
                        break;
                    }
                    case "close": {
                        this._closePresentationFile();
                        break;
                    }
                    case "minimize": {
                        const { id } = data;

                        if (
                            id ===
                                    store.getState().presentation.selectedFile
                                        .time
                        ) {
                            this._minimizePresentationFile(
                                store.getState().presentation
                                    .selectedFile
                            );
                        }

                        break;
                    }

                    case "maximize": {
                        break;
                    }
                    case "pageChange": {
                        const { id, pageNumber } = data;
                        this._changePageNumber(id, pageNumber);
                        break;
                    }
                    default: {
                        logger.error(
                            "Unknown method requested of presentFile"
                        );
                    }
                    }
                    break;
                }

                default: {
                    logger.error(
                        'unknown notification.method "%s"',
                        notification.method
                    );
                }
                }
            } catch (error) {
                logger.error('Error on server request "%s"', error);
                // store.dispatch(
                //     requestActions.notify({
                //         type: "error",
                //         text: intl.formatMessage({
                //             id: "socket.requestError",
                //             defaultMessage: "Error on server request",
                //         }),
                //     })
                // );
            }
        });
    }

    async _joinRoom({ joinVideo, joinAudio, returning }) {
        logger.debug("_joinRoom()");

        const { enableOpusDetails } = store.getState().settings;

        try {
            store.dispatch(roomActions.setRoomState("connecting"));

            // this._torrentSupport = WebTorrent.WEBRTC_SUPPORT;

            // this._webTorrent = this._torrentSupport && new WebTorrent();

            // this._webTorrent.on("error", (error) => {
            //     logger.error('Filesharing [error:"%o"]', error);

            //     store.dispatch(
            //         requestActions.notify({
            //             type : "error",
            //             text : intl.formatMessage({
            //                 id             : "filesharing.error",
            //                 defaultMessage : "There was a filesharing error",
            //             }),
            //         })
            //     );
            // });

            this._mediasoupDevice = new mediasoupClient.Device();

            const routerRtpCapabilities = await this.sendRequest(
                "getRouterRtpCapabilities"
            );

            logger.debug(
                "this.sendRequest('getRouterRtpCapabilities') [result:'%o']",
                routerRtpCapabilities
            );

            routerRtpCapabilities.headerExtensions =
                routerRtpCapabilities.headerExtensions.filter(
                    (ext) => ext.uri !== "urn:3gpp:video-orientation"
                );

            await this._mediasoupDevice.load({ routerRtpCapabilities });

            if (this._produce) {
                const transportInfo = await this.sendRequest(
                    "createWebRtcTransport",
                    {
                        forceTcp  : this._forceTcp,
                        producing : true,
                        consuming : false,
                    }
                );

                const { id, iceParameters, iceCandidates, dtlsParameters } =
                    transportInfo;

                this._sendTransport = this._mediasoupDevice.createSendTransport(
                    {
                        id,
                        iceParameters,
                        iceCandidates,
                        dtlsParameters,
                        iceServers         : this._turnServers,
                        // TODO: Fix for issue #72
                        iceTransportPolicy :
                            this._device.flag === "firefox" && this._turnServers
                                ? "relay"
                                : undefined,
                        proprietaryConstraints : PC_PROPRIETARY_CONSTRAINTS,
                    }
                );

                this._sendTransport.on(
                    "connect",
                    (
                        { dtlsParameters },
                        callback,
                        errback // eslint-disable-line no-shadow
                    ) => {
                        this.sendRequest("connectWebRtcTransport", {
                            transportId : this._sendTransport.id,
                            dtlsParameters,
                        })
                            .then(callback)
                            .catch(errback);
                    }
                );

                this._sendTransport.on(
                    "connectionstatechange",
                    (connectState) => {
                        switch (connectState) {
                        case "disconnected":
                        case "failed":
                            this.restartIce(
                                this._sendTransport,
                                this._sendRestartIce,
                                2000
                            );
                            break;

                        default:
                            clearTimeout(this._sendRestartIce.timer);
                            break;
                        }
                    }
                );

                this._sendTransport.on(
                    "produce",
                    async (
                        { kind, rtpParameters, appData },
                        callback,
                        errback
                    ) => {
                        try {
                            const { id } = await this.sendRequest("produce", {
                                transportId : this._sendTransport.id,
                                kind,
                                rtpParameters,
                                appData,
                            });

                            callback({ id });
                        } catch (error) {
                            errback(error);
                        }
                    }
                );
            }

            const transportInfo = await this.sendRequest(
                "createWebRtcTransport",
                {
                    forceTcp  : this._forceTcp,
                    producing : false,
                    consuming : true,
                }
            );

            const { id, iceParameters, iceCandidates, dtlsParameters } =
                transportInfo;

            this._recvTransport = this._mediasoupDevice.createRecvTransport({
                id,
                iceParameters,
                iceCandidates,
                dtlsParameters,
                iceServers         : this._turnServers,
                // TODO: Fix for issue #72
                iceTransportPolicy :
                    this._device.flag === "firefox" && this._turnServers
                        ? "relay"
                        : undefined,
                additionalSettings : {
                    encodedInsertableStreams :
                        insertableStreamsSupported && enableOpusDetails,
                },
                appData : {
                    encodedInsertableStreams :
                        insertableStreamsSupported && enableOpusDetails,
                },
            });

            this._recvTransport.on(
                "connect",
                (
                    { dtlsParameters },
                    callback,
                    errback // eslint-disable-line no-shadow
                ) => {
                    this.sendRequest("connectWebRtcTransport", {
                        transportId : this._recvTransport.id,
                        dtlsParameters,
                    })
                        .then(callback)
                        .catch(errback);
                }
            );

            this._recvTransport.on("connectionstatechange", (connectState) => {
                switch (connectState) {
                case "disconnected":
                case "failed":
                    this.restartIce(
                        this._recvTransport,
                        this._recvRestartIce,
                        2000
                    );
                    break;

                default:
                    clearTimeout(this._recvRestartIce.timer);
                    break;
                }
            });

            // Set our media capabilities.
            store.dispatch(
                meActions.setMediaCapabilities({
                    canSendMic     : this._mediasoupDevice.canProduce("audio"),
                    canSendWebcam  : this._mediasoupDevice.canProduce("video"),
                    canShareScreen :
                        this._mediasoupDevice.canProduce("video") &&
                        this._screenSharing.isScreenShareAvailable(),
                    // canShareFiles : this._torrentSupport,
                })
            );

            const {
                authenticated,
                roles,
                peers,
                tracker,
                roomPermissions,
                userRoles,
                allowWhenRoleMissing,
                chatHistory,
                fileHistory,
                lastNHistory,
                quizHistory,
                locked,
                lobbyPeers,
                accessCode,
                currentYoutubeLink,
                breakoutRooms,
            } = await this.sendRequest("join", {
                rtpCapabilities : this._mediasoupDevice.rtpCapabilities,
                returning,
                userInfo        : this._userInfo,
            });

            logger.debug(
                '_joinRoom() joined [authenticated:"%s", peers:"%o", roles:"%o", userRoles:"%o", breakoutRooms:"%o"]',
                authenticated,
                peers,
                roles,
                userRoles,
                breakoutRooms
            );

            // clear nessesery states
            this.clear();

            tracker && (this._tracker = tracker);

            // store.dispatch(meActions.loggedIn(authenticated));

            store.dispatch(roomActions.setRoomPermissions(roomPermissions));

            store.dispatch(roomActions.setBreakoutRooms(breakoutRooms));

            const roomUserRoles = new Map();

            Object.values(userRoles).forEach((val) =>
                roomUserRoles.set(val.id, val)
            );

            store.dispatch(roomActions.setUserRoles(roomUserRoles));

            if (allowWhenRoleMissing) {
                store.dispatch(
                    roomActions.setAllowWhenRoleMissing(allowWhenRoleMissing)
                );
            }

            const myRoles = store.getState().me.roles;

            for (const roleId of roles) {
                if (!myRoles.some((myRoleId) => roleId === myRoleId)) {
                    store.dispatch(meActions.addRole(roleId));
                }
            }

            for (const peer of peers) {
                store.dispatch(peerActions.addPeer({ ...peer, consumers: [] }));
            }

            chatHistory.length > 0 &&
                store.dispatch(chatActions.addChatHistory(chatHistory));

            fileHistory.length > 0 &&
                store.dispatch(fileActions.addFileHistory(fileHistory));

            quizHistory.length > 0 &&
                store.dispatch(quizActions.addQuizHistory(quizHistory));

            if (currentYoutubeLink) {
                this.getYoutubeManager().addYoutubeLink(
                    currentYoutubeLink.url,
                    currentYoutubeLink.ownerId,
                    currentYoutubeLink.progress,
                    currentYoutubeLink.status
                );
            }

            locked
                ? store.dispatch(roomActions.setRoomLocked())
                : store.dispatch(roomActions.setRoomUnLocked());

            lobbyPeers.length > 0 &&
                lobbyPeers.forEach((peer) => {
                    store.dispatch(lobbyPeerActions.addLobbyPeer(peer.id));
                    store.dispatch(
                        lobbyPeerActions.setLobbyPeerDisplayName(
                            peer.displayName,
                            peer.id
                        )
                    );
                    store.dispatch(
                        lobbyPeerActions.setLobbyPeerPicture(
                            peer.picture,
                            peer.id
                        )
                    );
                });

            accessCode != null &&
                store.dispatch(roomActions.setAccessCode(accessCode));

            // Don't produce if explicitly requested to not to do it.
            if (this._produce) {
                if (
                    joinVideo &&
                    this._havePermission(permissions.SHARE_VIDEO)
                ) {
                    this.updateWebcam({ init: true, start: true });
                }
                if (
                    joinAudio &&
                    this._mediasoupDevice.canProduce("audio") &&
                    this._havePermission(permissions.SHARE_AUDIO)
                ) {
                    if (!this._muted) {
                        await this.updateMic({ start: true });

                        let autoMuteThreshold = 4;

                        if ("autoMuteThreshold" in window.config) {
                            autoMuteThreshold = window.config.autoMuteThreshold;
                        }
                        if (
                            autoMuteThreshold &&
                            peers.length >= autoMuteThreshold
                        ) {
                            this.muteMic();
                        }
                    }
                }
            }

            await this._updateAudioOutputDevices();

            const { selectedAudioOutputDevice } = store.getState().settings;

            if (!selectedAudioOutputDevice && this._audioOutputDevices !== {}) {
                store.dispatch(
                    settingsActions.setSelectedAudioOutputDevice(
                        Object.keys(this._audioOutputDevices)[0]
                    )
                );
            }

            store.dispatch(roomActions.setRoomState("connected"));

            // Clean all the existing notifications.
            store.dispatch(notificationActions.removeAllNotifications());

            this._spotlights.addPeers(peers);

            if (lastNHistory.length > 0) {
                logger.debug("_joinRoom() | got lastN history");

                this._spotlights.addSpeakerList(
                    lastNHistory.filter((peerId) => peerId !== this._peerId)
                );
            }
        } catch (error) {
            logger.error('_joinRoom() [error:"%o"]', error);

            this.close();
        }
    }

    async lockRoom() {
        logger.debug("lockRoom()");

        try {
            await this.sendRequest("lockRoom");

            store.dispatch(roomActions.setRoomLocked());

            store.dispatch(
                requestActions.notify({
                    type : "warning",
                    text : intl.formatMessage({
                        id             : "room.youLocked",
                        defaultMessage : "You locked the room",
                    }),
                })
            );
        } catch (error) {
            store.dispatch(
                requestActions.notify({
                    type : "warning",
                    text : intl.formatMessage({
                        id             : "room.cantLock",
                        defaultMessage : "Unable to lock the room",
                    }),
                })
            );

            logger.error('lockRoom() [error:"%o"]', error);
        }
    }

    async unlockRoom() {
        logger.debug("unlockRoom()");

        try {
            await this.sendRequest("unlockRoom");

            store.dispatch(roomActions.setRoomUnLocked());

            store.dispatch(
                requestActions.notify({
                    type : "warning",
                    text : intl.formatMessage({
                        id             : "room.youUnLocked",
                        defaultMessage : "You unlocked the room",
                    }),
                })
            );
        } catch (error) {
            store.dispatch(
                requestActions.notify({
                    type : "warning",
                    text : intl.formatMessage({
                        id             : "room.cantUnLock",
                        defaultMessage : "Unable to unlock the room",
                    }),
                })
            );

            logger.error('unlockRoom() [error:"%o"]', error);
        }
    }

    async setAccessCode(code) {
        logger.debug("setAccessCode()");

        try {
            await this.sendRequest("setAccessCode", { accessCode: code });

            store.dispatch(roomActions.setAccessCode(code));

            // store.dispatch(
            //     requestActions.notify({
            //         text: "Access code saved.",
            //     })
            // );
        } catch (error) {
            logger.error('setAccessCode() [error:"%o"]', error);
            // store.dispatch(
            //     requestActions.notify({
            //         type: "error",
            //         text: "Unable to set access code.",
            //     })
            // );
        }
    }

    async setJoinByAccessCode(value) {
        logger.debug("setJoinByAccessCode()");

        try {
            await this.sendRequest("setJoinByAccessCode", {
                joinByAccessCode : value,
            });

            store.dispatch(roomActions.setJoinByAccessCode(value));

            // store.dispatch(
            //     requestActions.notify({
            //         text: `You switched Join by access-code to ${value}`,
            //     })
            // );
        } catch (error) {
            logger.error('setAccessCode() [error:"%o"]', error);
            // store.dispatch(
            //     requestActions.notify({
            //         type: "error",
            //         text: "Unable to set join by access code.",
            //     })
            // );
        }
    }

    async addExtraVideo(videoDeviceId) {
        logger.debug('addExtraVideo() [videoDeviceId:"%s"]', videoDeviceId);

        store.dispatch(roomActions.setExtraVideoOpen(false));

        if (!this._mediasoupDevice.canProduce("video")) {
            logger.error("addExtraVideo() | cannot produce video");

            return;
        }

        let track;

        store.dispatch(meActions.setWebcamInProgress(true));

        try {
            const device = this._webcams[videoDeviceId];
            const { resolution, aspectRatio, frameRate } =
                store.getState().settings;

            if (!device) {
                throw new Error("no webcam devices");
            }

            const stream = await navigator.mediaDevices.getUserMedia({
                video : {
                    deviceId : { ideal: videoDeviceId },
                    ...getVideoConstrains(resolution, aspectRatio),
                    frameRate,
                },
            });

            [track] = stream.getVideoTracks();

            const { width, height } = track.getSettings();

            logger.debug("extra video track settings:", track.getSettings());

            let exists = false;

            this._extraVideoProducers.forEach((value) => {
                if (value._track.label === track.label) {
                    exists = true;
                }
            });

            if (!exists) {
                let producer;

                const networkPriority = window.config.networkPriorities
                    ?.extraVideo
                    ? window.config.networkPriorities?.extraVideo
                    : DEFAULT_NETWORK_PRIORITIES.extraVideo;

                if (this._useSimulcast) {
                    const encodings = this._getEncodings(width, height);
                    const resolutionScalings = getResolutionScalings(encodings);

                    /** 
					 * TODO: 
					 * I receive DOMException: 
					 * Failed to execute 'addTransceiver' on 'RTCPeerConnection': 
					 * Attempted to set an unimplemented parameter of RtpParameters.
					encodings.forEach((encoding) =>
					{
						encoding.networkPriority=networkPriority;
					});
					*/

                    encodings[0].networkPriority = networkPriority;

                    producer = await this._sendTransport.produce({
                        track,
                        encodings,
                        codecOptions : {
                            videoGoogleStartBitrate : 1000,
                        },
                        appData : {
                            source : "extravideo",
                            width,
                            height,
                            resolutionScalings,
                        },
                    });
                } else {
                    producer = await this._sendTransport.produce({
                        track,
                        encodings : [{ networkPriority }],
                        appData   : {
                            source : "extravideo",
                            width,
                            height,
                        },
                    });
                }

                this._extraVideoProducers.set(producer.id, producer);

                store.dispatch(
                    producerActions.addProducer({
                        id            : producer.id,
                        deviceLabel   : device.label,
                        source        : "extravideo",
                        paused        : producer.paused,
                        track         : producer.track,
                        rtpParameters : producer.rtpParameters,
                        codec         : producer.rtpParameters.codecs[0].mimeType.split(
                            "/"
                        )[1],
                    })
                );

                // store.dispatch(settingsActions.setSelectedWebcamDevice(deviceId));

                await this._updateWebcams();

                producer.on("transportclose", () => {
                    this._extraVideoProducers.delete(producer.id);

                    producer = null;
                });

                producer.on("trackended", () => {
                    store.dispatch(
                        requestActions.notify({
                            type : "info",
                            text : intl.formatMessage({
                                id             : "devices.cameraDisconnected",
                                defaultMessage : "Camera disconnected",
                            }),
                        })
                    );

                    this.disableExtraVideo(producer.id).catch(() => {});
                });

                logger.debug("addExtraVideo() succeeded");
            } else {
                logger.error("addExtraVideo() duplicate");
                store.dispatch(
                    requestActions.notify({
                        type : "info",
                        text : intl.formatMessage({
                            id             : "room.extraVideoDuplication",
                            defaultMessage :
                                "Extra videodevice duplication errordefault",
                        }),
                    })
                );
            }
        } catch (error) {
            logger.error('addExtraVideo() [error:"%o"]', error);

            // store.dispatch(
            //     requestActions.notify({
            //         type: "error",
            //         text: intl.formatMessage({
            //             id: "devices.cameraError",
            //             defaultMessage:
            //                 "An error occurred while accessing your camera",
            //         }),
            //     })
            // );

            if (track) {
                track.stop();
            }
        }

        store.dispatch(meActions.setWebcamInProgress(false));
    }

    async disableMic() {
        logger.debug("disableMic()");

        if (!this._micProducer) {
            return;
        }

        store.dispatch(meActions.setAudioInProgress(true));

        this._micProducer.close();

        store.dispatch(producerActions.removeProducer(this._micProducer.id));

        try {
            await this.sendRequest("closeProducer", {
                producerId : this._micProducer.id,
            });
        } catch (error) {
            logger.error('disableMic() [error:"%o"]', error);
        }

        this._micProducer = null;

        store.dispatch(meActions.setAudioInProgress(false));
    }

    async updateRecorderPreferredMimeType({
        recorderPreferredMimeType = null,
    } = {}) {
        logger.debug(
            'updateRecorderPreferredMimeType [mime-type: "%s"]',
            recorderPreferredMimeType
        );
        store.dispatch(
            settingsActions.setRecorderPreferredMimeType(
                recorderPreferredMimeType
            )
        );
    }

    async updateScreenSharing({
        start = false,
        newResolution = null,
        newFrameRate = null,
    } = {}) {
        logger.debug('updateScreenSharing() [start:"%s"]', start);

        let track;

        try {
            const available = this._screenSharing.isScreenShareAvailable();

            const isAudioEnabled = this._screenSharing.isAudioEnabled();

            if (!available) {
                throw new Error("screen sharing not available");
            }

            if (!this._mediasoupDevice.canProduce("video")) {
                throw new Error("cannot produce video");
            }

            if (newResolution) {
                store.dispatch(
                    settingsActions.setScreenSharingResolution(newResolution)
                );
            }

            if (newFrameRate) {
                store.dispatch(
                    settingsActions.setScreenSharingFrameRate(newFrameRate)
                );
            }

            store.dispatch(meActions.setScreenShareInProgress(true));

            const {
                screenSharingResolution,
                autoGainControl,
                echoCancellation,
                noiseSuppression,
                aspectRatio,
                screenSharingFrameRate,
                sampleRate,
                channelCount,
                sampleSize,
                opusStereo,
                opusDtx,
                opusFec,
                opusPtime,
                opusMaxPlaybackRate,
            } = store.getState().settings;

            if (start) {
                let stream;

                if (isAudioEnabled) {
                    stream = await this._screenSharing.start({
                        ...getVideoConstrains(
                            screenSharingResolution,
                            aspectRatio
                        ),
                        frameRate : screenSharingFrameRate,
                        sampleRate,
                        channelCount,
                        autoGainControl,
                        echoCancellation,
                        noiseSuppression,
                        sampleSize,
                    });
                } else {
                    stream = await this._screenSharing.start({
                        ...getVideoConstrains(
                            screenSharingResolution,
                            aspectRatio
                        ),
                        frameRate : screenSharingFrameRate,
                    });
                }

                [track] = stream.getVideoTracks();

                const { width, height } = track.getSettings();

                logger.debug(
                    "screenSharing track settings:",
                    track.getSettings()
                );

                const networkPriority = window.config.networkPriorities
                    ?.screenShare
                    ? window.config.networkPriorities?.screenShare
                    : DEFAULT_NETWORK_PRIORITIES.screenShare;

                if (this._useSharingSimulcast) {
                    let encodings = this._getEncodings(width, height, true);

                    // If VP9 is the only available video codec then use SVC.
                    const firstVideoCodec =
                        this._mediasoupDevice.rtpCapabilities.codecs.find(
                            (c) => c.kind === "video"
                        );

                    if (
                        firstVideoCodec.mimeType.toLowerCase() !== "video/vp9"
                    ) {
                        encodings = encodings.map((encoding) => ({
                            ...encoding,
                            dtx : true,
                        }));
                    }

                    const resolutionScalings = getResolutionScalings(encodings);

                    /** 
					 * TODO: 
					 * I receive DOMException: 
					 * Failed to execute 'addTransceiver' on 'RTCPeerConnection': 
					 * Attempted to set an unimplemented parameter of RtpParameters.
					encodings.forEach((encoding) =>
					{
						encoding.networkPriority=networkPriority;
					});
					*/
                    encodings[0].networkPriority = networkPriority;

                    this._screenSharingProducer =
                        await this._sendTransport.produce({
                            track,
                            encodings,
                            codecOptions : {
                                videoGoogleStartBitrate : 1000,
                            },
                            appData : {
                                source : "screen",
                                width,
                                height,
                                resolutionScalings,
                            },
                        });
                } else {
                    this._screenSharingProducer =
                        await this._sendTransport.produce({
                            track,
                            encodings : [{ networkPriority }],
                            appData   : {
                                source : "screen",
                                width,
                                height,
                            },
                        });
                }

                store.dispatch(
                    producerActions.addProducer({
                        id            : this._screenSharingProducer.id,
                        deviceLabel   : "screen",
                        source        : "screen",
                        paused        : this._screenSharingProducer.paused,
                        track         : this._screenSharingProducer.track,
                        rtpParameters :
                            this._screenSharingProducer.rtpParameters,
                        codec : this._screenSharingProducer.rtpParameters.codecs[0].mimeType.split(
                            "/"
                        )[1],
                    })
                );

                this._screenSharingProducer.on("transportclose", () => {
                    this._screenSharingProducer = null;
                });

                this._screenSharingProducer.on("trackended", () => {
                    // store.dispatch(
                    //     requestActions.notify({
                    //         type: "info",
                    //         text: intl.formatMessage({
                    //             id: "devices.screenSharingDisconnected",
                    //             defaultMessage: "Screen sharing disconnected",
                    //         }),
                    //     })
                    // );

                    this.disableScreenSharing();
                });

                [track] = stream.getAudioTracks();

                if (isAudioEnabled && track) {
                    this._screenSharingAudioProducer =
                        await this._sendTransport.produce({
                            track,
                            codecOptions : {
                                opusStereo,
                                opusFec,
                                opusDtx,
                                opusMaxPlaybackRate,
                                opusPtime,
                            },
                            appData : { source: "mic" },
                        });

                    store.dispatch(
                        producerActions.addProducer({
                            id            : this._screenSharingAudioProducer.id,
                            source        : "mic",
                            paused        : this._screenSharingAudioProducer.paused,
                            track         : this._screenSharingAudioProducer.track,
                            rtpParameters :
                                this._screenSharingAudioProducer.rtpParameters,
                            codec : this._screenSharingAudioProducer.rtpParameters.codecs[0].mimeType.split(
                                "/"
                            )[1],
                        })
                    );

                    this._screenSharingAudioProducer.on(
                        "transportclose",
                        () => {
                            this._screenSharingAudioProducer = null;
                        }
                    );

                    this._screenSharingAudioProducer.on("trackended", () => {
                        // store.dispatch(
                        //     requestActions.notify({
                        //         type: "info",
                        //         text: intl.formatMessage({
                        //             id: "devices.screenSharingDisconnected",
                        //             defaultMessage:
                        //                 "Screen sharing disconnected",
                        //         }),
                        //     })
                        // );
                        // this.disableScreenSharing();
                    });

                    this._screenSharingAudioProducer.volume = 0;
                }
            } else {
                if (this._screenSharingProducer) {
                    ({ track } = this._screenSharingProducer);

                    await track.applyConstraints({
                        ...getVideoConstrains(
                            screenSharingResolution,
                            aspectRatio
                        ),
                        frameRate : screenSharingFrameRate,
                    });
                }
                if (this._screenSharingAudioProducer) {
                    ({ track } = this._screenSharingAudioProducer);

                    await track.applyConstraints({
                        sampleRate,
                        channelCount,
                        autoGainControl,
                        echoCancellation,
                        noiseSuppression,
                        sampleSize,
                    });
                }
            }

            this.sendRequest("shareScreen", { disable: false });
        } catch (error) {
            logger.error('updateScreenSharing() [error:"%o"]', error);

            // store.dispatch(
            //     requestActions.notify({
            //         type: "error",
            //         text: intl.formatMessage({
            //             id: "devices.screenSharingError",
            //             defaultMessage:
            //                 "An error occurred while accessing your screen",
            //         }),
            //     })
            // );

            if (track) {
                track.stop();
            }
        }

        store.dispatch(meActions.setScreenShareInProgress(false));
    }

    async disableScreenSharing() {
        logger.debug("disableScreenSharing()");

        if (!this._screenSharingProducer) {
            return;
        }

        store.dispatch(meActions.setScreenShareInProgress(true));

        this._screenSharingProducer.close();

        store.dispatch(
            producerActions.removeProducer(this._screenSharingProducer.id)
        );

        try {
            await this.sendRequest("closeProducer", {
                producerId : this._screenSharingProducer.id,
            });
        } catch (error) {
            logger.error('disableScreenSharing() [error:"%o"]', error);
        }

        this._screenSharingProducer = null;

        this._screenSharing.stop();

        this.sendRequest("shareScreen", { disable: true });

        store.dispatch(meActions.setScreenShareInProgress(false));
    }

    async disableExtraVideo(id) {
        logger.debug("disableExtraVideo()");

        const producer = this._extraVideoProducers.get(id);

        if (!producer) {
            return;
        }

        store.dispatch(meActions.setWebcamInProgress(true));

        producer.close();

        store.dispatch(producerActions.removeProducer(id));

        try {
            await this.sendRequest("closeProducer", { producerId: id });
        } catch (error) {
            logger.error('disableWebcam() [error:"%o"]', error);
        }

        this._extraVideoProducers.delete(id);

        store.dispatch(meActions.setWebcamInProgress(false));
    }

    async disableWebcam() {
        logger.debug("disableWebcam");

        if (!this._webcamProducer) {
            store.dispatch(settingsActions.setVideoMuted(true));
            return;
        }

        store.dispatch(meActions.setWebcamInProgress(true));

        this._webcamProducer.close();

        store.dispatch(producerActions.removeProducer(this._webcamProducer.id));

        try {
            await this.sendRequest("closeProducer", {
                producerId : this._webcamProducer.id,
            });
        } catch (error) {
            logger.error('disableWebcam() [error:"%o"]', error);
        }

        this._webcamProducer = null;
        store.dispatch(settingsActions.setVideoMuted(true));
        store.dispatch(meActions.setWebcamInProgress(false));
        logger.debug("disableWebcam(3)");
    }

    async _setNoiseThreshold(threshold) {
        if (!this._hark) {return;}

        logger.debug('_setNoiseThreshold() [threshold:"%s"]', threshold);

        this._hark.setThreshold(threshold);

        store.dispatch(settingsActions.setNoiseThreshold(threshold));
    }

    async _updateAudioDevices() {
        logger.debug("_updateAudioDevices()");

        // Reset the list.
        this._audioDevices = {};

        try {
            logger.debug("_updateAudioDevices() | calling enumerateDevices()");

            const devices = await navigator.mediaDevices.enumerateDevices();

            for (const device of devices) {
                if (device.kind !== "audioinput") {
                    continue;
                }

                this._audioDevices[device.deviceId] = device;
            }

            store.dispatch(meActions.setAudioDevices(this._audioDevices));
        } catch (error) {
            logger.error('_updateAudioDevices() [error:"%o"]', error);
        }
    }

    async _updateWebcams() {
        logger.debug("_updateWebcams()");

        // Reset the list.
        this._webcams = {};

        try {
            logger.debug("_updateWebcams() | calling enumerateDevices()");

            const devices = await navigator.mediaDevices.enumerateDevices();

            for (const device of devices) {
                if (device.kind !== "videoinput") {
                    continue;
                }

                this._webcams[device.deviceId] = device;
            }

            store.dispatch(meActions.setWebcamDevices(this._webcams));
        } catch (error) {
            logger.error('_updateWebcams() [error:"%o"]', error);
        }
    }

    async _getAudioDeviceId() {
        logger.debug("_getAudioDeviceId()");

        try {
            logger.debug(
                "_getAudioDeviceId() | calling _updateAudioDeviceId()"
            );

            await this._updateAudioDevices();

            const { selectedAudioDevice } = store.getState().settings;

            if (
                selectedAudioDevice &&
                this._audioDevices[selectedAudioDevice]
            ) {
                return selectedAudioDevice;
            }

            const audioDevices = Object.values(this._audioDevices);

            return audioDevices[0] ? audioDevices[0].deviceId : null;
        } catch (error) {
            logger.error('_getAudioDeviceId() [error:"%o"]', error);
        }
    }

    async _getAudioOutputDeviceId() {
        logger.debug("_getAudioOutputDeviceId()");

        try {
            logger.debug(
                "_getAudioOutputDeviceId() | calling _updateAudioOutputDevices()"
            );

            await this._updateAudioOutputDevices();

            const { selectedAudioOutputDevice } = store.getState().settings;

            if (
                selectedAudioOutputDevice &&
                this._audioOutputDevices[selectedAudioOutputDevice]
            ) {
                return selectedAudioOutputDevice;
            }

            const audioOutputDevices = Object.values(this._audioOutputDevices);

            return audioOutputDevices[0]
                ? audioOutputDevices[0].deviceId
                : null;
        } catch (error) {
            logger.error('_getAudioDeviceId() [error:"%o"]', error);
        }
    }

    async _getWebcamDeviceId() {
        logger.debug("_getWebcamDeviceId()");

        try {
            logger.debug("_getWebcamDeviceId() | calling _updateWebcams()");

            await this._updateWebcams();

            const { selectedWebcam } = store.getState().settings;

            if (selectedWebcam && this._webcams[selectedWebcam]) {
                return selectedWebcam;
            }

            const webcams = Object.values(this._webcams);

            return webcams[0] ? webcams[0].deviceId : null;
        } catch (error) {
            logger.error('_getWebcamDeviceId() [error:"%o"]', error);
        }
    }

    async _updateAudioOutputDevices() {
        logger.debug("_updateAudioOutputDevices()");

        // Reset the list.
        this._audioOutputDevices = {};

        try {
            logger.debug(
                "_updateAudioOutputDevices() | calling enumerateDevices()"
            );

            const devices = await navigator.mediaDevices.enumerateDevices();

            for (const device of devices) {
                if (device.kind !== "audiooutput") {
                    continue;
                }

                this._audioOutputDevices[device.deviceId] = device;
            }

            store.dispatch(
                meActions.setAudioOutputDevices(this._audioOutputDevices)
            );
        } catch (error) {
            logger.error('_updateAudioOutputDevices() [error:"%o"]', error);
        }
    }

    async startRecord() {
        logger.debug("startRecord");
        try {
            await this.sendRequest("moderator:setRecording", {
                method         : RECORDING_START,
                recordingState : RECORDING_START,
            });

            store.dispatch(roomActions.setRecordingState(RECORDING_START));

            store.dispatch(
                requestActions.notify({
                    type : "error",
                    text : "conference starts recording",
                })
            );
        } catch (error) {
            // store.dispatch(
            //     requestActions.notify({
            //         type: "error",
            //         text: this.intl.formatMessage({
            //             id: "room.unexpectedErrorDuringLocalRecording",
            //             defaultMessage:
            //                 "Unexpected error ocurred during local recording",
            //         }),
            //     })
            // );

            logger.error('startRecord() [error:"%o"]', error);
        }
    }

    async stopRecord() {
        logger.debug("stopRecord");
        try {
            await this.sendRequest("moderator:setRecording", {
                method         : RECORDING_STOP,
                recordingState : RECORDING_STOP,
            });

            store.dispatch(roomActions.setRecordingState(RECORDING_STOP));

            store.dispatch(
                requestActions.notify({
                    type : "error",
                    text : "conference stop recording",
                })
            );
        } catch (error) {
            // store.dispatch(
            //     requestActions.notify({
            //         type: "error",
            //         text: this.intl.formatMessage({
            //             id: "room.unexpectedErrorDuringLocalRecording",
            //             defaultMessage:
            //                 "Unexpected error ocurred during local recording",
            //         }),
            //     })
            // );
            logger.error('stopRecord() [error:"%o"]', error);
        }
    }

    _havePermission(permission) {
        const { roomPermissions, allowWhenRoleMissing } = store.getState().room;

        if (!roomPermissions) {
            return false;
        }

        const { roles } = store.getState().me;

        const permitted = roles.some((userRoleId) =>
            roomPermissions[permission].some(
                (permissionRole) => userRoleId === permissionRole.id
            )
        );

        if (permitted) {
            return true;
        }

        if (!allowWhenRoleMissing) {
            return false;
        }

        const peers = Object.values(store.getState().peers);

        // Allow if config is set, and no one is present
        if (
            allowWhenRoleMissing.includes(permission) &&
            peers.filter((peer) =>
                peer.roles.some((roleId) =>
                    roomPermissions[permission].some(
                        (permissionRole) => roleId === permissionRole.id
                    )
                )
            ).length === 0
        ) {
            return true;
        }

        return false;
    }

    _closeConsumer(consumerId) {
        const consumer = this._consumers.get(consumerId);

        this._spotlights.removeVideoConsumer(consumerId);

        if (!consumer) {
            return;
        }

        consumer.close();

        if (consumer.hark != null) {
            consumer.hark.stop();
        }

        this._consumers.delete(consumerId);

        const { peerId } = consumer.appData;

        store.dispatch(consumerActions.removeConsumer(consumerId, peerId));
    }

    _chooseEncodings(simulcastProfiles, size) {
        let encodings;

        const sortedMap = new Map(
            [...Object.entries(simulcastProfiles)].sort(
                (a, b) => parseInt(b[0]) - parseInt(a[0])
            )
        );

        for (const [key, value] of sortedMap) {
            if (key < size) {
                if (encodings === null) {
                    encodings = value;
                }

                break;
            }

            encodings = value;
        }

        // hack as there is a bug in mediasoup
        if (encodings.length === 1) {
            encodings.push({ ...encodings[0] });
        }

        return encodings;
    }

    _getEncodings(width, height, screenSharing = false) {
        // If VP9 is the only available video codec then use SVC.
        const firstVideoCodec =
            this._mediasoupDevice.rtpCapabilities.codecs.find(
                (c) => c.kind === "video"
            );

        let encodings;

        const size = width > height ? width : height;

        if (firstVideoCodec.mimeType.toLowerCase() === "video/vp9") {
            encodings = screenSharing
                ? VIDEO_SVC_ENCODINGS
                : VIDEO_KSVC_ENCODINGS;
        } else if (window.config.simulcastProfiles) {
            encodings = this._chooseEncodings(
                window.config.simulcastProfiles,
                size
            );
        } else {
            encodings = this._chooseEncodings(VIDEO_SIMULCAST_PROFILES, size);
        }

        return encodings;
    }

    setHideNoVideoParticipants(hideNoVideoParticipants) {
        this._spotlights.hideNoVideoParticipants = hideNoVideoParticipants;
    }

    async updateDevices() {
        await this._updateAudioDevices();
        await this._updateWebcams();
        await this._updateAudioOutputDevices();
    }

    async disableLocalWebcam() {
        logger.debug("disableLocalWebcam()");
        store.dispatch(meActions.setWebcamInProgress(true));
        let deviceId = null;
        if (this._localSelectedWebcamId) {
            deviceId = this._localSelectedWebcamId;
        } else {
            deviceId = await this._getWebcamDeviceId();
        }
        store.dispatch(producerActions.removeProducer(deviceId));
        this._localSelectedWebcamId = null;
        store.dispatch(settingsActions.setVideoMuted(true));
        store.dispatch(meActions.setWebcamInProgress(false));
    }

    async updateLocalWebcam({
        init = false,
        start = false,
        restart = false,
        newDeviceId = null,
        newResolution = null,
        newFrameRate = null,
    }) {
        let track;

        try {
            if (newDeviceId) {
                store.dispatch(
                    settingsActions.setSelectedWebcamDevice(newDeviceId)
                );
            }

            if (newResolution) {
                store.dispatch(
                    settingsActions.setVideoResolution(newResolution)
                );
            }

            if (newFrameRate) {
                store.dispatch(settingsActions.setVideoFrameRate(newFrameRate));
            }

            const { videoMuted } = store.getState().settings;

            if (init && videoMuted) {
                return;
            }

            if (restart || start) {
                if (this._localSelectedWebcamId) {
                    this.disableLocalWebcam();
                }

                // store.dispatch(settingsActions.setVideoMuted(false));

                store.dispatch(meActions.setWebcamInProgress(true));

                const deviceId = await this._getWebcamDeviceId();
                const device = this._webcams[deviceId];

                if (!device) {
                    throw new Error("no webcam devices");
                }

                const { resolution, aspectRatio, frameRate } =
                    store.getState().settings;

                const videoContraints = getVideoConstrains(
                    resolution,
                    aspectRatio
                );

                const stream = await navigator.mediaDevices.getUserMedia({
                    video : {
                        deviceId : { ideal: deviceId },
                        ...videoContraints,
                        frameRate,
                    },
                });

                [track] = stream.getVideoTracks();

                const { deviceId: trackDeviceId } = track.getSettings();

                const localSelectedWebcamId = `${trackDeviceId  }localwebcam`;

                this._localSelectedWebcamId = localSelectedWebcamId;

                store.dispatch(
                    producerActions.addProducer({
                        id     : localSelectedWebcamId,
                        source : "webcam",
                        track,
                    })
                );

                store.dispatch(settingsActions.setVideoMuted(false));
            }

            // await this._updateWebcams();
        } catch (error) {
            logger.error('updateLocalWebcam() [error:"%o"]', error);

            // store.dispatch(
            //     requestActions.notify({
            //         type: "error",
            //         text: intl.formatMessage({
            //             id: "devices.cameraError",
            //             defaultMessage:
            //                 "An error occurred while accessing your camera",
            //         }),
            //     })
            // );

            if (track) {
                track.stop();
            }
        }

        store.dispatch(meActions.setWebcamInProgress(false));
    }
    async disableLocalMic() {
        logger.debug("disableLocalMic()");
        store.dispatch(meActions.setAudioInProgress(true));
        let deviceId = null;
        if (this._localSelectedMicId) {
            deviceId = this._localSelectedMicId;
        } else {
            deviceId = await this._getAudioDeviceId();
        }
        store.dispatch(producerActions.removeProducer(deviceId));
        this._localSelectedMicId = null;
        store.dispatch(settingsActions.setAudioMuted(true));
        store.dispatch(meActions.setAudioInProgress(false));
    }

    async updateLocalMic({
        start = false,
        restart = true,
        newDeviceId = null,
    } = {}) {
        logger.debug(
            'updateLocalMic() [start:"%s", restart:"%s", newDeviceId:"%s"]',
            start,
            restart,
            newDeviceId
        );

        let track;

        try {
            if (newDeviceId && !restart) {
                throw new Error("changing device requires restart");
            }

            if (newDeviceId) {
                store.dispatch(
                    settingsActions.setSelectedAudioDevice(newDeviceId)
                );
            }

            store.dispatch(meActions.setAudioInProgress(true));

            const deviceId = await this._getAudioDeviceId();
            const device = this._audioDevices[deviceId];

            if (!device) {
                throw new Error("no audio devices");
            }

            const {
                autoGainControl,
                echoCancellation,
                noiseSuppression,
                sampleRate,
                channelCount,
                sampleSize,
            } = store.getState().settings;

            if (restart || start) {
                if (this._localSelectedMicId) {
                    this.disableLocalMic();
                }
                // this.disconnectLocalHark();

                const stream = await navigator.mediaDevices.getUserMedia({
                    audio : {
                        deviceId : { ideal: deviceId },
                        sampleRate,
                        channelCount,
                        autoGainControl,
                        echoCancellation,
                        noiseSuppression,
                        sampleSize,
                    },
                });

                [track] = stream.getAudioTracks();

                const { deviceId: trackDeviceId } = track.getSettings();

                const localSelectedMicId = `${trackDeviceId  }localmic`;

                this._localSelectedMicId = localSelectedMicId;

                store.dispatch(
                    producerActions.addProducer({
                        id     : localSelectedMicId,
                        source : "mic",
                        track,
                    })
                );

                store.dispatch(settingsActions.setAudioMuted(false));
                // this.connectLocalHark(track);
            }

            // TODO update recorder inputs
            /* 
			if (recorder != null)
			{
				recorder.addTrack(new MediaStream([ this._micProducer.track ]));
			}
			*/
            // await this._updateAudioDevices();
        } catch (error) {
            logger.error('updateLocalMic() [error:"%o"]', error);

            // store.dispatch(
            //     requestActions.notify({
            //         type: "error",
            //         text: intl.formatMessage({
            //             id: "devices.microphoneError",
            //             defaultMessage:
            //                 "An error occurred while accessing your microphone",
            //         }),
            //     })
            // );

            if (track) {
                track.stop();
            }
        }

        store.dispatch(meActions.setAudioInProgress(false));
    }

    clearLocalSelectedMedia() {
        store.dispatch(producerActions.clearProducers());
        this._localSelectedMicId = null;
        this._localSelectedWebcamId = null;
    }

    _updateLocalMedia() {
        logger.debug("_updateLocalMedia()");
        const { videoMuted, audioMuted } = store.getState().settings;

        if (!videoMuted) {this.updateLocalWebcam({ start: true });}

        if (!audioMuted) {this.updateLocalMic({ start: true });}
    }

    async requestPeerInfo({ tk = this._peerTk, roomId = this.roomId }) {
        logger.debug("getting peer info");
        try {
            const res = await Service.getPeerInfo({ roomId, tk });

            const { id, name, email, picture, roleIds } = res.data;

            this._peerId = id;

            store.dispatch(
                meActions.setMe({
                    peerId       : id,
                    loginEnabled : true,
                })
            );

            this._userInfo.displayName = name;
            store.dispatch(settingsActions.setDisplayName(name));

            this._userInfo.picture = picture;
            if (picture) {
                store.dispatch(meActions.setPicture(picture));
            }
            this._userInfo.roleIds = roleIds;
            this._userInfo.email = email;
        } catch (error) {
            logger.error("requestPeerInfo %o", error);
        }
    }

    check({ roomId, roomKey }) {
        logger.debug("Checking room is status");

        store.dispatch(roomActions.setRoomLoading(true));

        Service
            .canJoin({ roomId, roomKey })
            .then((_res) => {
                store.dispatch(roomActions.setRoomLoading(false));
                store.dispatch(roomActions.toggleCanJoin(true));
                this._updateLocalMedia();
            })
            .catch((error) => {
                logger.error("check API call %o", error);
                store.dispatch(roomActions.setRoomLoading(false));
                if (error.status !== 200)
                {store.dispatch(roomActions.setRoomState("expired"));}
            });
    }
}
