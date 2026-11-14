import { connect } from "node:net";
const socket = connect(process.env.OMB_BRIDGE_SOCKET);
socket.on("connect", () => { process.stdin.pipe(socket); socket.pipe(process.stdout); });
socket.on("error", () => process.exit(1));
socket.on("close", () => process.exit(0));
