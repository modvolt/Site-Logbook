import modvoltLogo from "@assets/Color_logo_-_no_background_1780171783567.png";

export const BRAND_NAME = "Modvolt s.r.o.";
export const BRAND_LOGO_URL = modvoltLogo;

let cachedLogoDataUrl: string | null = null;

export async function getBrandLogoDataUrl(): Promise<string> {
  if (cachedLogoDataUrl) return cachedLogoDataUrl;
  const res = await fetch(modvoltLogo);
  const blob = await res.blob();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  cachedLogoDataUrl = dataUrl;
  return dataUrl;
}
