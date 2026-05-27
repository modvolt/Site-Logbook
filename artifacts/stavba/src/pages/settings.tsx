import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun, Monitor, Building2, Upload, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  loadCompanySettings,
  saveCompanySettings,
} from "@/lib/company-settings";

const MAX_LOGO_BYTES = 500 * 1024;

export default function Settings() {
  const { theme, setTheme } = useTheme();
  const [companyName, setCompanyName] = useState("");
  const [logoDataUrl, setLogoDataUrl] = useState("");
  const [logoError, setLogoError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const s = loadCompanySettings();
    setCompanyName(s.name);
    setLogoDataUrl(s.logoDataUrl);
  }, []);

  function persist(next: { name?: string; logoDataUrl?: string }) {
    const merged = {
      name: next.name ?? companyName,
      logoDataUrl: next.logoDataUrl ?? logoDataUrl,
    };
    saveCompanySettings(merged);
    setSavedAt(Date.now());
  }

  function onNameBlur() {
    persist({ name: companyName });
  }

  function onLogoFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setLogoError(null);
    if (!/^image\/(png|jpeg|jpg)$/i.test(file.type)) {
      setLogoError("Použijte obrázek PNG nebo JPG.");
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError("Logo je větší než 500 kB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || "");
      setLogoDataUrl(url);
      persist({ logoDataUrl: url });
    };
    reader.readAsDataURL(file);
    if (fileRef.current) fileRef.current.value = "";
  }

  function clearLogo() {
    setLogoDataUrl("");
    persist({ logoDataUrl: "" });
  }

  const themes = [
    { value: "light", label: "Světlý", icon: Sun },
    { value: "dark", label: "Tmavý", icon: Moon },
    { value: "system", label: "Systémový", icon: Monitor },
  ];

  return (
    <div className="p-4 md:p-8 max-w-2xl mx-auto w-full space-y-6">
      <h1 className="text-2xl font-bold">Nastavení</h1>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sun className="h-5 w-5" /> Vzhled aplikace
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">Vyberte barevný režim zobrazení.</p>
          <div className="grid grid-cols-3 gap-3">
            {themes.map(({ value, label, icon: Icon }) => {
              const isActive = theme === value;
              return (
                <button
                  key={value}
                  onClick={() => setTheme(value)}
                  className={`flex flex-col items-center gap-3 p-4 rounded-xl border-2 transition-all ${
                    isActive
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  <Icon className="h-7 w-7" />
                  <span className="text-sm font-medium">{label}</span>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="h-5 w-5" /> Firma (záhlaví PDF)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Název a logo se zobrazí v záhlaví exportovaných PDF.
          </p>

          <div className="space-y-2">
            <Label htmlFor="company-name">Název firmy</Label>
            <Input
              id="company-name"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              onBlur={onNameBlur}
              placeholder="Např. Stavby Novák s.r.o."
            />
          </div>

          <div className="space-y-2">
            <Label>Logo</Label>
            <div className="flex items-center gap-3">
              {logoDataUrl ? (
                <div className="h-16 w-24 border rounded-md bg-muted/30 flex items-center justify-center overflow-hidden">
                  <img
                    src={logoDataUrl}
                    alt="Logo firmy"
                    className="max-h-full max-w-full object-contain"
                  />
                </div>
              ) : (
                <div className="h-16 w-24 border border-dashed rounded-md flex items-center justify-center text-xs text-muted-foreground">
                  Bez loga
                </div>
              )}
              <div className="flex flex-col gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileRef.current?.click()}
                  className="gap-2"
                >
                  <Upload className="h-4 w-4" />
                  {logoDataUrl ? "Změnit logo" : "Nahrát logo"}
                </Button>
                {logoDataUrl && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={clearLogo}
                    className="gap-2 text-muted-foreground"
                  >
                    <X className="h-4 w-4" />
                    Odebrat
                  </Button>
                )}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg"
                className="hidden"
                onChange={onLogoFile}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              PNG nebo JPG, max 500 kB. Doporučeno: průhledné PNG.
            </p>
            {logoError && (
              <p className="text-xs text-destructive">{logoError}</p>
            )}
          </div>

          {savedAt && (
            <p className="text-xs text-muted-foreground">Uloženo.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
