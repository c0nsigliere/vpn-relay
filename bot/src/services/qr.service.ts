import QRCode from "qrcode";

class QrService {
  async generate(text: string): Promise<Buffer> {
    return QRCode.toBuffer(text, {
      errorCorrectionLevel: "M",
      type: "png",
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    });
  }
}

export const qrService = new QrService();
