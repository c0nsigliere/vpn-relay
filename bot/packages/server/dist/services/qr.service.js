"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.qrService = void 0;
const qrcode_1 = __importDefault(require("qrcode"));
class QrService {
    async generate(text) {
        return qrcode_1.default.toBuffer(text, {
            errorCorrectionLevel: "M",
            type: "png",
            margin: 2,
            color: { dark: "#000000", light: "#ffffff" },
        });
    }
}
exports.qrService = new QrService();
//# sourceMappingURL=qr.service.js.map