from pathlib import Path
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib.colors import HexColor, white


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output" / "pdf"
OUT.mkdir(parents=True, exist_ok=True)

W, H = A4
M = 40
NAVY = HexColor("#101827")
INK = HexColor("#1F2937")
MUTED = HexColor("#667085")
LINE = HexColor("#D8DEE8")
PAPER = HexColor("#F7F9FC")
TEAL = HexColor("#0F8B8D")
BLUE = HexColor("#2563EB")
GREEN = HexColor("#16845B")
AMBER = HexColor("#D98E04")
RED = HexColor("#C2414B")
SOFT_TEAL = HexColor("#E7F6F5")
SOFT_BLUE = HexColor("#EAF1FF")
SOFT_GREEN = HexColor("#E9F7F0")
SOFT_AMBER = HexColor("#FFF4D8")
SOFT_RED = HexColor("#FDEBED")

pdfmetrics.registerFont(TTFont("UI", r"C:\Windows\Fonts\arial.ttf"))
pdfmetrics.registerFont(TTFont("UIB", r"C:\Windows\Fonts\arialbd.ttf"))


def wrap(text, font, size, width):
    words = text.split()
    lines, current = [], ""
    for word in words:
        candidate = word if not current else current + " " + word
        if pdfmetrics.stringWidth(candidate, font, size) <= width:
            current = candidate
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def text(c, value, x, y, width, size=10, color=INK, font="UI", leading=None):
    leading = leading or size * 1.35
    c.setFillColor(color)
    c.setFont(font, size)
    lines = wrap(value, font, size, width)
    for line in lines:
        c.drawString(x, y, line)
        y -= leading
    return y


def header(c, audience, title, subtitle, page, total):
    c.setFillColor(PAPER)
    c.rect(0, 0, W, H, fill=1, stroke=0)
    c.setFillColor(NAVY)
    c.rect(0, H - 104, W, 104, fill=1, stroke=0)
    c.setFillColor(TEAL if audience == "ZAMĚSTNANEC" else BLUE)
    c.roundRect(M, H - 38, 104, 19, 4, fill=1, stroke=0)
    c.setFillColor(white)
    c.setFont("UIB", 8)
    c.drawCentredString(M + 52, H - 31, audience)
    c.setFont("UIB", 20)
    c.drawString(M, H - 66, title)
    c.setFont("UI", 9.5)
    c.setFillColor(HexColor("#C8D3E3"))
    c.drawString(M, H - 86, subtitle)
    c.setFillColor(MUTED)
    c.setFont("UI", 8)
    c.drawRightString(W - M, 22, f"Modvolt Site Logbook | {page}/{total}")


def badge(c, x, y, label, color, bg, width=None):
    width = width or max(62, pdfmetrics.stringWidth(label, "UIB", 8) + 18)
    c.setFillColor(bg)
    c.roundRect(x, y - 14, width, 20, 5, fill=1, stroke=0)
    c.setFillColor(color)
    c.setFont("UIB", 8)
    c.drawCentredString(x + width / 2, y - 7, label)
    return width


def card(c, x, y, w, h, title, body, color=TEAL, bg=white, number=None):
    c.setFillColor(bg)
    c.setStrokeColor(LINE)
    c.roundRect(x, y - h, w, h, 6, fill=1, stroke=1)
    if number is not None:
        c.setFillColor(color)
        c.circle(x + 20, y - 23, 12, fill=1, stroke=0)
        c.setFillColor(white)
        c.setFont("UIB", 10)
        c.drawCentredString(x + 20, y - 26.5, str(number))
        tx = x + 40
    else:
        c.setFillColor(color)
        c.rect(x, y - h, 5, h, fill=1, stroke=0)
        tx = x + 16
    c.setFillColor(INK)
    c.setFont("UIB", 11)
    c.drawString(tx, y - 22, title)
    text(c, body, tx, y - 42, w - (tx - x) - 13, 8.6, MUTED, leading=11.5)


def arrow(c, x1, y1, x2, y2, color=MUTED):
    c.setStrokeColor(color)
    c.setFillColor(color)
    c.setLineWidth(1.5)
    c.line(x1, y1, x2, y2)
    import math
    angle = math.atan2(y2 - y1, x2 - x1)
    for delta in (2.55, -2.55):
        c.line(x2, y2, x2 + 8 * math.cos(angle + delta), y2 + 8 * math.sin(angle + delta))


def flow(c, labels, y, colors):
    gap = 14
    box_w = (W - 2 * M - gap * (len(labels) - 1)) / len(labels)
    for i, label in enumerate(labels):
        x = M + i * (box_w + gap)
        color, bg = colors[i]
        c.setFillColor(bg)
        c.setStrokeColor(color)
        c.roundRect(x, y - 56, box_w, 56, 6, fill=1, stroke=1)
        c.setFillColor(color)
        c.circle(x + 18, y - 18, 9, fill=1, stroke=0)
        c.setFillColor(white)
        c.setFont("UIB", 8)
        c.drawCentredString(x + 18, y - 21, str(i + 1))
        text(c, label, x + 33, y - 16, box_w - 40, 8.5, INK, "UIB", 10)
        if i < len(labels) - 1:
            arrow(c, x + box_w + 2, y - 28, x + box_w + gap - 2, y - 28)


def ui_row(c, x, y, w, title, subtitle, state, color, bg):
    c.setFillColor(white)
    c.setStrokeColor(LINE)
    c.roundRect(x, y - 48, w, 48, 5, fill=1, stroke=1)
    c.setFillColor(HexColor("#EEF1F5"))
    c.roundRect(x + 11, y - 37, 28, 28, 4, fill=1, stroke=0)
    c.setFillColor(INK)
    c.setFont("UIB", 9)
    c.drawString(x + 48, y - 18, title)
    c.setFillColor(MUTED)
    c.setFont("UI", 7.5)
    c.drawString(x + 48, y - 32, subtitle)
    badge(c, x + w - 95, y - 15, state, color, bg, 82)


def checklist(c, x, y, title, items, color=GREEN, width=230):
    c.setFillColor(INK)
    c.setFont("UIB", 11)
    c.drawString(x, y, title)
    y -= 22
    for item in items:
        c.setFillColor(color)
        c.circle(x + 5, y + 3, 4, fill=1, stroke=0)
        c.setStrokeColor(white)
        c.setLineWidth(1)
        c.line(x + 3, y + 3, x + 5, y + 1)
        c.line(x + 5, y + 1, x + 8, y + 6)
        y = text(c, item, x + 16, y + 7, width - 16, 8.7, INK, leading=11.5) - 6
    return y


def employee_pdf():
    path = OUT / "modvolt-navod-zamestnanec-doklady.pdf"
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setTitle("Modvolt - návod pro zaměstnance: doklady")
    c.setAuthor("Modvolt")
    c.setSubject("Fotografování a nahrávání přijatých dokladů")
    total = 4

    header(c, "ZAMĚSTNANEC", "Doklad bez ztraceného materiálu", "Od fotografie po správně přiřazenou zakázku", 1, total)
    flow(c, ["Vyfoťte celý doklad", "Vyberte správný režim", "Nahrajte a zkontrolujte", "Nejasnost ponechte ke kontrole"], H - 145,
         [(TEAL, SOFT_TEAL), (BLUE, SOFT_BLUE), (GREEN, SOFT_GREEN), (AMBER, SOFT_AMBER)])
    card(c, M, H - 235, 245, 120, "Základní pravidlo", "Fotografie samotného čísla dodacího listu nestačí pro materiál a množství. Číslo pomůže s párováním, ale pro sklad a cenu musí být čitelné také položky.", TEAL, SOFT_TEAL)
    card(c, M + 265, H - 235, 250, 120, "Kdy stačí jedna fotografie", "Účtenka nebo jednostránkový dodací list: celý dokument v jednom záběru, bez odříznutých rohů, stínu a rozmazání.", BLUE, SOFT_BLUE)
    checklist(c, M, H - 390, "Před odesláním musí být čitelné", ["číslo dokladu a dodavatel", "všechny položky, množství a jednotky", "datum a celková částka, pokud na dokladu jsou", "číslo dodacího listu, objednávky nebo zakázky"], width=245)
    checklist(c, M + 285, H - 390, "Když něco není jisté", ["Nevymýšlejte chybějící údaj.", "Zakázku nevybírejte odhadem.", "Poškozený doklad vyfoťte znovu a přidejte poznámku.", "Doklad pro více zakázek ponechte administrátorovi k rozdělení."], AMBER, 245)
    c.showPage()

    header(c, "ZAMĚSTNANEC", "Jak správně fotografovat", "Jedna stránka = celý čitelný list", 2, total)
    card(c, M, H - 140, 245, 180, "SPRÁVNĚ", "Doklad leží rovně. V záběru jsou všechny čtyři rohy. Text je ostrý, bez odlesku. Foto je pořízené kolmo shora.", GREEN, SOFT_GREEN)
    c.setFillColor(white); c.setStrokeColor(GREEN); c.roundRect(M + 25, H - 285, 195, 88, 4, fill=1, stroke=1)
    c.setFillColor(HexColor("#E8EDF3")); c.rect(M + 43, H - 269, 159, 58, fill=1, stroke=0)
    c.setFillColor(INK); c.setFont("UIB", 8); c.drawString(M + 53, H - 225, "DODACÍ LIST DL-2026-184")
    for i in range(3): c.line(M + 53, H - 239 - i * 9, M + 187, H - 239 - i * 9)
    card(c, M + 265, H - 140, 250, 180, "ŠPATNĚ", "Vyfocené jen číslo, chybějící spodní část, šikmý záběr, malý text, pohybová neostrost nebo zakrytá část dokladu.", RED, SOFT_RED)
    c.setStrokeColor(RED); c.setLineWidth(3); c.line(M + 295, H - 220, M + 485, H - 280); c.line(M + 485, H - 220, M + 295, H - 280)
    card(c, M, H - 355, W - 2*M, 88, "Více stran", "Vyfoťte každou stranu zvlášť a ve správném pořadí. Při společném výběru fotografií zvolte možnost „Jeden vícestránkový doklad“. Poslední strana často obsahuje součet nebo položku Celkem.", BLUE, SOFT_BLUE)
    card(c, M, H - 463, W - 2*M, 88, "PDF", "Nahrajte původní PDF jako jeden soubor. Nerozdělujte jej na fotografie. Aplikace předá AI všechny stránky společně a zachová jejich pořadí.", TEAL, SOFT_TEAL)
    c.showPage()

    header(c, "ZAMĚSTNANEC", "Nahrání v aplikaci", "Fakturace > Přijaté doklady > Nahrát doklady", 3, total)
    flow(c, ["Otevřete Přijaté doklady", "Vyberte PDF nebo fotografie", "Potvrďte jeden či více dokladů", "Počkejte na dokončení uploadu"], H - 145,
         [(BLUE, SOFT_BLUE), (TEAL, SOFT_TEAL), (AMBER, SOFT_AMBER), (GREEN, SOFT_GREEN)])
    c.setFillColor(white); c.setStrokeColor(LINE); c.roundRect(M, H - 360, W - 2*M, 155, 6, fill=1, stroke=1)
    c.setFillColor(NAVY); c.rect(M, H - 244, W - 2*M, 39, fill=1, stroke=0)
    c.setFillColor(white); c.setFont("UIB", 11); c.drawString(M + 15, H - 229, "Jsou to stránky jednoho dokladu?")
    card(c, M + 18, H - 265, 225, 70, "Jeden vícestránkový doklad", "Více fotografií jedné faktury nebo dodacího listu.", TEAL, SOFT_TEAL)
    card(c, M + 258, H - 265, 220, 70, "Samostatné doklady", "Každý vybraný soubor je jiný doklad.", BLUE, SOFT_BLUE)
    checklist(c, M, H - 405, "Po nahrání", ["Zkontrolujte, že aplikace oznámila počet nahraných stran.", "Při hlášení duplicity nevkládejte soubor opakovaně.", "Chybu uploadu řešte novým pokusem se stejnými soubory a pořadím."], width=500)
    c.showPage()

    header(c, "ZAMĚSTNANEC", "Neobvyklé situace", "Jednoduché rozhodnutí předchází chybnému skladu", 4, total)
    ui_row(c, M, H - 145, W - 2*M, "Zakázka není známá", "Doklad nahrajte bez odhadu", "KE KONTROLE", AMBER, SOFT_AMBER)
    ui_row(c, M, H - 205, W - 2*M, "Jeden doklad pro více zakázek", "Nerozdělujte fotografie, rozdělí se jednotlivé položky", "ADMIN", BLUE, SOFT_BLUE)
    ui_row(c, M, H - 265, W - 2*M, "Nečitelný nebo poškozený doklad", "Pořiďte nové fotografie a uveďte poznámku", "NOVÉ FOTO", RED, SOFT_RED)
    ui_row(c, M, H - 325, W - 2*M, "Faktura přišla později e-mailem", "Dodací list musí mít čitelné číslo a položky", "SPÁROVAT", TEAL, SOFT_TEAL)
    ui_row(c, M, H - 385, W - 2*M, "Aplikace hlásí duplicitu", "Nevytvářejte nový doklad, informujte administrátora", "ZASTAVIT", RED, SOFT_RED)
    card(c, M, H - 475, W - 2*M, 95, "Co nikdy nedělat", "Nemažte doklad jen proto, že nesedí částka. Nezakládejte každou stránku jako samostatnou fakturu. Nepotvrzujte zakázku odhadem. Nefoťte pouze číslo, pokud jsou na dokladu materiálové položky.", RED, SOFT_RED)
    c.save()
    return path


def admin_pdf():
    path = OUT / "modvolt-navod-administrator-prijate-doklady.pdf"
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setTitle("Modvolt - návod pro administrátora: přijaté doklady")
    c.setAuthor("Modvolt")
    c.setSubject("Kontrola, párování, duplicity a schvalování přijatých dokladů")
    total = 6

    header(c, "ADMINISTRÁTOR", "Denní kontrola přijatých dokladů", "Bezpečný postup od AI návrhu po sklad a fakturaci", 1, total)
    flow(c, ["Přijaté doklady", "Kontrola AI", "Vazby a zakázky", "Položky a sklad", "Schválení"], H - 145,
         [(BLUE, SOFT_BLUE), (AMBER, SOFT_AMBER), (TEAL, SOFT_TEAL), (GREEN, SOFT_GREEN), (BLUE, SOFT_BLUE)])
    card(c, M, H - 230, W - 2*M, 90, "Doporučené pořadí", "Nejdřív ověřte originál a úplnost stran. Potom hlavičku a součty. Teprve následně potvrďte vazby, rozdělte položky a schvalte doklad. Schválení spouští návazné skladové a cenové operace.", BLUE, SOFT_BLUE)
    checklist(c, M, H - 355, "Rychlá denní kontrola", ["Doklad není neúplný ani duplicitní.", "Číslo, dodavatel a typ dokladu odpovídají originálu.", "Součet položek odpovídá základu a položce Celkem.", "Každý materiál má potvrzenou zakázku, sklad nebo nefakturovat.", "Vazba dodací list - faktura je potvrzená, ne pouze navržená."], width=500)
    c.showPage()

    header(c, "ADMINISTRÁTOR", "Kontrola AI vytěžení", "AI je návrh, originál je zdroj pravdy", 2, total)
    ui_row(c, M, H - 145, W - 2*M, "Typ dokladu", "Faktura, dodací list, účtenka nebo dobropis", "OVĚŘIT", AMBER, SOFT_AMBER)
    ui_row(c, M, H - 205, W - 2*M, "Identita", "Dodavatel, IČO, číslo dokladu a variabilní symbol", "OVĚŘIT", AMBER, SOFT_AMBER)
    ui_row(c, M, H - 265, W - 2*M, "Částky", "Základ, DPH, celkem a měna", "SOUČET", BLUE, SOFT_BLUE)
    ui_row(c, M, H - 325, W - 2*M, "Strany", "Počet stran, pořadí a položka Celkem", "ÚPLNOST", TEAL, SOFT_TEAL)
    card(c, M, H - 410, 245, 105, "Když součet nesedí", "Neschvalujte. Porovnejte položky s originálem, zkontrolujte slevy, poplatky, přenos z další strany a cenu za balení.", RED, SOFT_RED)
    card(c, M + 265, H - 410, 250, 105, "Znovu analyzovat", "Použijte v modulu Přijaté doklady. Schválené nebo fakturačně uzamčené položky se nesmí automaticky přepsat.", AMBER, SOFT_AMBER)
    c.showPage()

    header(c, "ADMINISTRÁTOR", "Dodací list a přijatá faktura", "Reference určuje vztah, potvrzení určuje důvěru", 3, total)
    flow(c, ["Dodací list u zakázky", "Číslo a položky", "Faktura z e-mailu", "Automatický návrh", "Ruční potvrzení"], H - 145,
         [(TEAL, SOFT_TEAL), (BLUE, SOFT_BLUE), (TEAL, SOFT_TEAL), (AMBER, SOFT_AMBER), (GREEN, SOFT_GREEN)])
    card(c, M, H - 235, 250, 115, "Automatický návrh", "Systém porovnává číslo dodacího listu, dodavatele, datum, částky a položky. Návrh bez potvrzení není definitivní vazba.", AMBER, SOFT_AMBER)
    card(c, M + 270, H - 235, 245, 115, "Ruční rozhodnutí", "V části Vazby na dodací listy a zakázky vyberte správný doklad nebo zakázku a potvrďte. Odmítnutý návrh se znovu automaticky nepotvrdí.", GREEN, SOFT_GREEN)
    checklist(c, M, H - 390, "Minimum pro spolehlivé párování", ["číslo dodacího listu bez chyby OCR", "stejný dodavatel nebo IČO", "shodné položky či objednávka", "správná zakázka potvrzená administrátorem"], width=245)
    checklist(c, M + 285, H - 390, "Kdy párovat ručně", ["AI přečetla jiné číslo", "faktura sdružuje více dodacích listů", "dodací list nemá cenu", "existuje více podobných zakázek"], AMBER, 245)
    c.showPage()

    header(c, "ADMINISTRÁTOR", "Rozdělení mezi zakázky", "Rozdělují se položky nebo množství, ne soubor dokladu", 4, total)
    card(c, M, H - 145, W - 2*M, 80, "Jedna faktura, více zakázek", "U každé položky vyberte zakázku. Pokud jedno množství patří na více zakázek, použijte Rozdělit a zadejte dílčí množství. Součet částí musí odpovídat původnímu množství.", BLUE, SOFT_BLUE)
    flow(c, ["Původní řádek 10 ks", "Rozdělit", "Zakázka #34 - 6 ks", "Zakázka #35 - 4 ks"], H - 260,
         [(AMBER, SOFT_AMBER), (BLUE, SOFT_BLUE), (TEAL, SOFT_TEAL), (GREEN, SOFT_GREEN)])
    checklist(c, M, H - 350, "Pro každý řádek určete", ["zakázku nebo akci", "režim: přefakturovat, interní, sklad, nefakturovat", "skladovou kartu, pokud jde o skladový materiál", "potvrzení vazby před schválením"], width=245)
    checklist(c, M + 285, H - 350, "Kontrola po rozdělení", ["nezměnila se celková částka", "nezmizelo ani nepřibylo množství", "každá část má správnou zakázku", "položka není už uzamčená vydanou fakturou"], GREEN, 245)
    c.showPage()

    header(c, "ADMINISTRÁTOR", "Duplicity a opravy", "Duplicita není koš a její zrušení nesmí ztratit soubor", 5, total)
    ui_row(c, M, H - 145, W - 2*M, "Možná duplicita", "Porovnejte originál, dodavatele, číslo, částku a všechny strany", "NÁVRH", AMBER, SOFT_AMBER)
    ui_row(c, M, H - 205, W - 2*M, "Potvrzená duplicita", "Označte až po vizuální kontrole obou dokladů", "DUPLICITA", RED, SOFT_RED)
    ui_row(c, M, H - 265, W - 2*M, "Chybné označení", "Použijte Zrušit duplicitu, doklad se vrátí ke kontrole", "OBNOVIT", BLUE, SOFT_BLUE)
    ui_row(c, M, H - 325, W - 2*M, "Schválený doklad", "Nejdřív zrušte schválení; systém blokuje nebezpečné sloučení", "BLOKOVÁNO", RED, SOFT_RED)
    card(c, M, H - 410, W - 2*M, 95, "Důležité", "Doklad nemažte jako způsob řešení duplicity. Smazání je jiná operace než zrušení párování. Ruční označení a zrušení duplicity se zapisuje do auditu včetně uživatele a času.", RED, SOFT_RED)
    c.showPage()

    header(c, "ADMINISTRÁTOR", "Schválení a následky", "Poslední kontrola před skladem, náklady a fakturací", 6, total)
    flow(c, ["Hlavička správně", "Vazby potvrzené", "Položky rozdělené", "Sklad přiřazen", "Schválit doklad"], H - 145,
         [(BLUE, SOFT_BLUE), (TEAL, SOFT_TEAL), (AMBER, SOFT_AMBER), (GREEN, SOFT_GREEN), (BLUE, SOFT_BLUE)])
    card(c, M, H - 235, 245, 115, "Schválení provede", "Propíše potvrzené materiály a ceny, připraví náklad pro zakázku a podle režimu vytvoří nebo upraví skladové pohyby.", GREEN, SOFT_GREEN)
    card(c, M + 265, H - 235, 250, 115, "Schválení neprovádějte", "Pokud chybí strana, nesedí částka, vazba je jen návrh, materiál není rozdělen nebo je doklad stále podezřelý jako duplicita.", RED, SOFT_RED)
    checklist(c, M, H - 390, "Po schválení ověřte", ["materiál je vidět u správné zakázky", "cena a množství odpovídají dokladu", "skladový pohyb má správný směr a skladovou kartu", "doklad se nenabízí k dvojímu přefakturování"], width=245)
    checklist(c, M + 285, H - 390, "Audit musí ukázat", ["kdo opravil nebo potvrdil referenci", "kdo označil či zrušil duplicitu", "kdo schválil doklad", "kdy proběhla AI analýza a ruční zásah"], BLUE, 245)
    c.save()
    return path


if __name__ == "__main__":
    for generated in (employee_pdf(), admin_pdf()):
        print(generated)
