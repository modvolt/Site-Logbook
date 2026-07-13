from pathlib import Path
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib.colors import HexColor, white
from reportlab.lib.utils import ImageReader


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output" / "pdf"
OUT.mkdir(parents=True, exist_ok=True)
PDF_PATH = OUT / "modvolt-rozvadece-graficky-navod.pdf"
FONT_DIR = ROOT / "artifacts" / "api-server" / "src" / "assets" / "fonts"
LOGO = ROOT / "attached_assets" / "Color_logo_-_no_background_1780171783567.png"

W, H = A4
M = 38
NAVY = HexColor("#101827")
INK = HexColor("#1F2937")
MUTED = HexColor("#667085")
LINE = HexColor("#D8DEE8")
PAPER = HexColor("#F6F8FB")
TEAL = HexColor("#0891B2")
GREEN = HexColor("#16845B")
AMBER = HexColor("#D98E04")
RED = HexColor("#C2414B")
BLUE = HexColor("#2563EB")
SOFT_TEAL = HexColor("#E6F7FA")
SOFT_GREEN = HexColor("#E9F7F0")
SOFT_AMBER = HexColor("#FFF4D8")
SOFT_RED = HexColor("#FDEBED")
SOFT_BLUE = HexColor("#EAF1FF")

pdfmetrics.registerFont(TTFont("Roboto", str(FONT_DIR / "Roboto-Regular.ttf")))
pdfmetrics.registerFont(TTFont("RobotoBold", str(FONT_DIR / "Roboto-Bold.ttf")))


def wrap(value, font, size, width):
    lines, current = [], ""
    for word in value.split():
        candidate = word if not current else f"{current} {word}"
        if pdfmetrics.stringWidth(candidate, font, size) <= width:
            current = candidate
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def draw_text(c, value, x, y, width, size=9, color=INK, font="Roboto", leading=None):
    leading = leading or size * 1.35
    c.setFont(font, size)
    c.setFillColor(color)
    for line in wrap(value, font, size, width):
        c.drawString(x, y, line)
        y -= leading
    return y


def page(c, number, total, role, title, subtitle):
    c.setFillColor(PAPER)
    c.rect(0, 0, W, H, fill=1, stroke=0)
    c.setFillColor(NAVY)
    c.rect(0, H - 104, W, 104, fill=1, stroke=0)
    if LOGO.exists():
        c.drawImage(ImageReader(str(LOGO)), M, H - 42, width=92, height=25, preserveAspectRatio=True, mask="auto")
    c.setFillColor(TEAL if role == "PRACOVNÍK" else BLUE)
    c.roundRect(W - M - 108, H - 37, 108, 19, 4, fill=1, stroke=0)
    c.setFillColor(white)
    c.setFont("RobotoBold", 8)
    c.drawCentredString(W - M - 54, H - 31, role)
    c.setFont("RobotoBold", 19)
    c.drawString(M, H - 68, title)
    c.setFont("Roboto", 9.3)
    c.setFillColor(HexColor("#C8D3E3"))
    c.drawString(M, H - 87, subtitle)
    c.setFont("Roboto", 7.5)
    c.setFillColor(MUTED)
    c.drawRightString(W - M, 20, f"Modvolt Site Logbook | Rozvaděče | {number}/{total}")


def badge(c, x, y, value, color, bg, width=76):
    c.setFillColor(bg)
    c.roundRect(x, y - 14, width, 20, 5, fill=1, stroke=0)
    c.setFillColor(color)
    c.setFont("RobotoBold", 8)
    c.drawCentredString(x + width / 2, y - 7, value)


def card(c, x, y, width, height, title, body, color=TEAL, bg=white, number=None):
    c.setFillColor(bg)
    c.setStrokeColor(LINE)
    c.roundRect(x, y - height, width, height, 6, fill=1, stroke=1)
    tx = x + 16
    if number is not None:
        c.setFillColor(color)
        c.circle(x + 21, y - 22, 12, fill=1, stroke=0)
        c.setFillColor(white)
        c.setFont("RobotoBold", 10)
        c.drawCentredString(x + 21, y - 25.5, str(number))
        tx = x + 42
    else:
        c.setFillColor(color)
        c.rect(x, y - height, 5, height, fill=1, stroke=0)
    c.setFont("RobotoBold", 10.5)
    c.setFillColor(INK)
    c.drawString(tx, y - 21, title)
    draw_text(c, body, tx, y - 41, width - (tx - x) - 14, 8.4, MUTED, leading=11.2)


def arrow(c, x1, y1, x2, y2, color=MUTED):
    c.setStrokeColor(color)
    c.setFillColor(color)
    c.setLineWidth(1.4)
    c.line(x1, y1, x2, y2)
    c.line(x2, y2, x2 - 6, y2 + 3)
    c.line(x2, y2, x2 - 6, y2 - 3)


def flow(c, labels, y, palette):
    gap = 10
    width = (W - 2 * M - gap * (len(labels) - 1)) / len(labels)
    for index, label in enumerate(labels):
        x = M + index * (width + gap)
        color, bg = palette[index]
        c.setFillColor(bg)
        c.setStrokeColor(color)
        c.roundRect(x, y - 58, width, 58, 6, fill=1, stroke=1)
        c.setFillColor(color)
        c.circle(x + 18, y - 18, 9, fill=1, stroke=0)
        c.setFillColor(white)
        c.setFont("RobotoBold", 8)
        c.drawCentredString(x + 18, y - 21, str(index + 1))
        draw_text(c, label, x + 31, y - 15, width - 38, 8.1, INK, "RobotoBold", 9.6)
        if index < len(labels) - 1:
            arrow(c, x + width + 1, y - 29, x + width + gap - 1, y - 29)


def row(c, x, y, width, title, detail, state, color, bg):
    c.setFillColor(white)
    c.setStrokeColor(LINE)
    c.roundRect(x, y - 49, width, 49, 5, fill=1, stroke=1)
    c.setFillColor(bg)
    c.circle(x + 23, y - 24, 12, fill=1, stroke=0)
    c.setFillColor(color)
    c.setFont("RobotoBold", 10)
    c.drawCentredString(x + 23, y - 27, state[:1])
    c.setFillColor(INK)
    c.setFont("RobotoBold", 9.2)
    c.drawString(x + 44, y - 18, title)
    c.setFillColor(MUTED)
    c.setFont("Roboto", 7.8)
    c.drawString(x + 44, y - 33, detail)
    badge(c, x + width - 92, y - 16, state, color, bg, 78)


def checks(c, x, y, title, items, width, color=GREEN):
    c.setFillColor(INK)
    c.setFont("RobotoBold", 10.5)
    c.drawString(x, y, title)
    y -= 20
    for item in items:
        c.setFillColor(color)
        c.circle(x + 5, y + 3, 4, fill=1, stroke=0)
        c.setStrokeColor(white)
        c.setLineWidth(1)
        c.line(x + 3, y + 3, x + 5, y + 1)
        c.line(x + 5, y + 1, x + 8, y + 6)
        y = draw_text(c, item, x + 16, y + 7, width - 16, 8.5, INK, leading=11.2) - 5


def create_pdf():
    c = canvas.Canvas(str(PDF_PATH), pagesize=A4)
    c.setTitle("Modvolt - grafický návod modulu Rozvaděče")
    c.setAuthor("Modvolt")
    c.setSubject("DBO dokumentace, průběžný protokol, štítek, QR a finální protokol")
    total = 6

    page(c, 1, total, "PRACOVNÍK + ADMIN", "Rozvaděč od založení po předání", "Jedna evidence pro výrobu, dokumentaci, štítek, QR a protokol")
    flow(c, ["Založit rozvaděč", "Nahrát DBO PDF", "Vyrobit a kontrolovat", "Schválit štítek", "Vytvořit protokol"], H - 145,
         [(BLUE, SOFT_BLUE), (TEAL, SOFT_TEAL), (AMBER, SOFT_AMBER), (GREEN, SOFT_GREEN), (BLUE, SOFT_BLUE)])
    card(c, M, H - 235, 248, 112, "Co řeší modul", "Rozvaděč je vždy navázaný na zakázku. Uchovává DBO dokumenty, verze vytěžených údajů, výrobní checklist, měření, závady, fotografie, štítky, QR a finální A4 protokoly.", TEAL, SOFT_TEAL)
    card(c, M + 266, H - 235, 253, 112, "Co se nikdy nepřepisuje", "Nový DBO soubor, štítek i protokol vytvářejí novou verzi. Starší originály a audit zůstávají dostupné. Smazání původního dokumentu není součástí běžného workflow.", BLUE, SOFT_BLUE)
    checks(c, M, H - 390, "Pracovník", ["vyplňuje fáze postupně i během více dnů", "přidává měření, fotografie a závady", "vidí pouze operace povolené jeho oprávněním"], 240, TEAL)
    checks(c, M + 280, H - 390, "Administrátor", ["kontroluje AI vytěžení a kandidáty", "spravuje QR, štítky, šablony a audit", "schvaluje nebo s odůvodněním řeší blokace"], 240, BLUE)
    c.showPage()

    page(c, 2, total, "PRACOVNÍK", "Výroba může trvat více dnů", "Rozpracovaný stav se ukládá po jednotlivých fázích a pracovnících")
    flow(c, ["Sestavení a zapojení", "Kontrola před zapnutím", "Měření a dokončení"], H - 145,
         [(TEAL, SOFT_TEAL), (AMBER, SOFT_AMBER), (GREEN, SOFT_GREEN)])
    row(c, M, H - 235, W - 2 * M, "Den 1 - Václav", "Dotažení spojů, PE/N svorky, označení vodičů", "ULOŽENO", TEAL, SOFT_TEAL)
    row(c, M, H - 296, W - 2 * M, "Den 2 - Jan", "Kontrola krytů, záslepek a shody s dokumentací", "ULOŽENO", BLUE, SOFT_BLUE)
    row(c, M, H - 357, W - 2 * M, "Den 3 - revizní měření", "Izolace, kontinuita, RCD a výsledné fotografie", "DOKONČENO", GREEN, SOFT_GREEN)
    card(c, M, H - 435, 248, 112, "Závada", "Výsledek Závada vyžaduje popis. Kritická otevřená závada blokuje dokončení a protokol. Po opravě ji oprávněná osoba uzavře s popisem opravy.", RED, SOFT_RED)
    card(c, M + 266, H - 435, 253, 112, "Neaplikovatelné", "Bod označte Neaplikuje se pouze se zdůvodněním. Vlastnosti rozvaděče mohou skrýt opravdu nerelevantní body, například měření RCD bez proudového chrániče.", AMBER, SOFT_AMBER)
    card(c, M, H - 568, W - 2 * M, 82, "Důležité", "Nezakládejte nový rozvaděč jen proto, že práce pokračuje další den. Otevřete stejný rozvaděč a pokračujte v aktuální fázi. Každý zápis uchovává pracovníka, čas a auditní historii.", BLUE, SOFT_BLUE)
    c.showPage()

    page(c, 3, total, "ADMINISTRÁTOR", "SchrackNorm DBO a AI vytěžení", "Parser nejdříve hledá název pole a teprve potom jeho hodnotu")
    flow(c, ["Privátní uložení PDF", "Textová vrstva", "Lokální OCR fallback", "Validace a confidence", "Revize nebo štítek"], H - 145,
         [(BLUE, SOFT_BLUE), (TEAL, SOFT_TEAL), (AMBER, SOFT_AMBER), (GREEN, SOFT_GREEN), (BLUE, SOFT_BLUE)])
    card(c, M, H - 235, 248, 118, "Automaticky dokončeno", "Všechna povinná pojmenovaná pole jsou validní a nad nastavenou hranicí. Hodnoty se propíší do rozvaděče, vytvoří se QR a schválená verze PDF/PNG štítku.", GREEN, SOFT_GREEN)
    card(c, M + 266, H - 235, 253, 118, "Vyžaduje kontrolu", "Chybí pole, hodnota je neplatná, confidence je nízká nebo existuje více rovnocenných stran či hodnot. Finální štítek se v tomto stavu nevydá.", AMBER, SOFT_AMBER)
    c.setFillColor(white)
    c.setStrokeColor(LINE)
    c.roundRect(M, H - 525, W - 2 * M, 150, 6, fill=1, stroke=1)
    c.setFont("RobotoBold", 10.5)
    c.setFillColor(INK)
    c.drawString(M + 16, H - 399, "Příklad ručního rozhodnutí")
    c.setFont("Roboto", 8.5)
    c.setFillColor(MUTED)
    c.drawString(M + 16, H - 419, "Název pole: Napětí | strana 3 | textová vrstva | jistota 50 %")
    badge(c, M + 18, H - 449, "400 V", BLUE, SOFT_BLUE, 82)
    badge(c, M + 110, H - 449, "230 V", BLUE, SOFT_BLUE, 82)
    arrow(c, M + 204, H - 456, M + 285, H - 456, AMBER)
    c.setFillColor(SOFT_AMBER)
    c.setStrokeColor(AMBER)
    c.roundRect(M + 300, H - 477, 183, 47, 5, fill=1, stroke=1)
    draw_text(c, "Vyberte hodnotu podle originálu a uveďte důvod opravy.", M + 312, H - 448, 160, 8.2, INK, "RobotoBold", 10)
    card(c, M, H - 555, W - 2 * M, 82, "Znovu zpracovat", "Použijte u konkrétní verze DBO, když se změnil parser nebo byla analýza chybná. Stejný soubor nevytvoří duplicitní automatický štítek. Nový DBO soubor vytvoří novou verzi dokumentu a štítku.", TEAL, SOFT_TEAL)
    c.showPage()

    page(c, 4, total, "ADMINISTRÁTOR", "Typový štítek a QR dokumentace", "PDF 100 x 60 mm, PNG 300 DPI a veřejný odkaz bez databázového ID")
    flow(c, ["Potvrzená data", "Neprůhledný QR token", "PDF + PNG", "Schválená verze", "Veřejná stránka"], H - 145,
         [(GREEN, SOFT_GREEN), (TEAL, SOFT_TEAL), (BLUE, SOFT_BLUE), (GREEN, SOFT_GREEN), (TEAL, SOFT_TEAL)])
    card(c, M, H - 235, 248, 118, "Veřejně", "Označení, výrobní číslo, výrobce, datum, stav dokumentace, kontakt a pouze dokumenty, které administrátor výslovně označil jako veřejné.", TEAL, SOFT_TEAL)
    card(c, M + 266, H - 235, 253, 118, "Interně", "Zakázka, umístění, checklist, měření, závady, neveřejné dokumenty, audit a technické detaily jsou dostupné jen po přihlášení a s oprávněním.", BLUE, SOFT_BLUE)
    row(c, M, H - 380, W - 2 * M, "Rotace QR", "Starý token se okamžitě zneplatní. Nový štítek použije nový odkaz.", "BEZPEČNOST", RED, SOFT_RED)
    row(c, M, H - 441, W - 2 * M, "Deaktivace QR", "Veřejná stránka přestane fungovat, interní data a verze zůstanou.", "VYPNUTO", AMBER, SOFT_AMBER)
    row(c, M, H - 502, W - 2 * M, "Archivace rozvaděče", "QR se deaktivuje a rozvaděč zůstane v historické evidenci.", "ARCHIV", BLUE, SOFT_BLUE)
    card(c, M, H - 580, W - 2 * M, 84, "Ochrana tokenu", "Databáze obsahuje hash pro vyhledání a šifrovanou podobu pro generování štítku. API neposílá hash, šifrovaný token ani privátní S3 cestu do běžného frontendu.", GREEN, SOFT_GREEN)
    c.showPage()

    page(c, 5, total, "ADMINISTRÁTOR", "Finální A4 výrobní protokol", "Neměnný snapshot aktuálních dat, checklistu, měření, závad a schváleného štítku")
    flow(c, ["Dokončené fáze", "Povinné fotografie", "Platná měření", "Bez kritických závad", "Schválený štítek"], H - 145,
         [(GREEN, SOFT_GREEN), (BLUE, SOFT_BLUE), (TEAL, SOFT_TEAL), (RED, SOFT_RED), (GREEN, SOFT_GREEN)])
    checks(c, M, H - 245, "Protokol obsahuje", ["zakázku a technické údaje rozvaděče", "použitou verzi checklistové šablony", "pracovníky a čas jednotlivých kontrol", "výsledky měření a historii závad", "fotodokumentaci, QR a verzi štítku", "pole Zhotovil a Převzal / zákazník"], 240, BLUE)
    checks(c, M + 280, H - 245, "Co vytvoření blokuje", ["nedokončená povinná fáze", "chybějící povinný bod nebo fotografie", "nevyhovující povinné měření", "otevřená kritická závada", "neaktivní QR nebo neschválený štítek", "chybějící povinné údaje rozvaděče"], 240, RED)
    card(c, M, H - 478, W - 2 * M, 90, "Administrátorská výjimka", "Použijte pouze s oprávněním a povinným odůvodněním. Protokol uloží všechny překonané blokace, jméno uživatele a čas. Výjimka neopravuje technický stav, pouze jej transparentně zaznamená.", AMBER, SOFT_AMBER)
    card(c, M, H - 588, W - 2 * M, 80, "Verzování", "Změna dat po vytvoření protokolu staré PDF nepřepočítá. Pro aktuální stav vytvořte novou verzi. Staré protokoly zůstávají dohledatelné.", BLUE, SOFT_BLUE)
    c.showPage()

    page(c, 6, total, "PRACOVNÍK + ADMIN", "Když něco nejde", "Bezpečný postup bez mazání originálů a obcházení kontrol")
    row(c, M, H - 145, W - 2 * M, "PDF je poškozené nebo chráněné heslem", "Nahrajte platný nešifrovaný originál jako novou verzi.", "NOVÝ SOUBOR", RED, SOFT_RED)
    row(c, M, H - 206, W - 2 * M, "Typový štítek nebyl nalezen", "Ověřte celý DBO dokument a případně doplňte potvrzená pole ručně.", "KONTROLA", AMBER, SOFT_AMBER)
    row(c, M, H - 267, W - 2 * M, "OCR nebo storage selhalo", "Použijte Znovu zpracovat až po odstranění příčiny; originál zůstává uložen.", "OPAKOVAT", BLUE, SOFT_BLUE)
    row(c, M, H - 328, W - 2 * M, "QR je neaktivní nebo expirované", "Aktivujte či rotujte QR a poté vytvořte novou verzi štítku.", "QR", TEAL, SOFT_TEAL)
    row(c, M, H - 389, W - 2 * M, "Protokol je blokovaný", "Otevřete Připravenost a vyřešte všechny konkrétní blokace.", "DOPLNIT", RED, SOFT_RED)
    card(c, M, H - 480, 248, 112, "Nikdy", "Nemažte DBO nebo štítek jen proto, že nesedí hodnota. Neobcházejte kritickou závadu změnou běžného stavu. Nesdílejte privátní S3 URL ani token z administrace.", RED, SOFT_RED)
    card(c, M + 266, H - 480, 253, 112, "Vždy", "Porovnejte originál, opravte konkrétní pole s důvodem, použijte novou verzi a ověřte audit. U finálního protokolu zkontrolujte připravenost před schválením.", GREEN, SOFT_GREEN)
    c.save()
    return PDF_PATH


if __name__ == "__main__":
    print(create_pdf())
