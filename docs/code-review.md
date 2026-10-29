# Ponovni pregled kode – Study Notes

**Datum:** 29. 10. 2026  
**Veja:** `feature/scaffold`  
**Obseg:** ponoven pregled trenutne kode na veji, primerjava z `CLAUDE.md`, `docs/spec.md`, README in testi. To je statični pregled prek GitHub API; ukazi projekta niso bili izvedeni. Spremenjena je samo ta datoteka s poročilom.

## Povzetek

Aplikacija je razmeroma dobro razdeljena na strežniške module, uporabniški vmesnik, bazo in opravila v ozadju. Pregledani SQL-klici za uporabniške podatke uporabljajo parametre; brisanje gradiva pravilno odstrani vektorje pred kosi, nato pa se z brisanjem prek tujih ključev odstranijo gradivo in zapiski. Sistemski pozivi za zapiske, združevanje zapiskov in RAG se ujemajo z bloki v specifikaciji, za kar obstajajo tudi testi.

V primerjavi s prejšnjo različico poročila sem popravil pomembno napako: iskanje 30 kandidatov pred filtriranjem po tečaju je izrecno določeno v specifikaciji, zato samo po sebi ni odstopanje od zahtev. Tudi manj kot šest zadetkov brez filtra je opisano kot znana omejitev v README. Glavne preostale skrbi so odsotnost časovne omejitve za Ollama zahteve, tekmovalni pogoji pri osveževanju seznama gradiv in varnostno tveganje, če bi bil API dosegljiv zunaj zaupanja vrednega omrežja.

## Ugotovitve

| ID | Resnost | Področje | Datoteka in vrstice | Težava | Predlagani popravek |
|---|---|---|---|---|---|
| CR-01 | **major** | Zanesljivost / obdelava v ozadju | `server/llm.js:118–126`; `server/jobs.js:49–71` | Klic `fetch()` do Ollame nima eksplicitne časovne omejitve ali `AbortSignal`. Če storitev vzpostavi povezavo, vendar ne odgovori, se indeksiranje ne zaključi. Ker se opravila izvajajo zaporedno, lahko viseča zahteva zadrži vsa nadaljnja indeksiranja in pripravo zapiskov; stanje ostane `processing`. | Dodati nastavljivo časovno omejitev za zahteve Ollama, ob prekoračitvi vrniti razumljivo napako in zagotoviti, da se status opravila zapiše kot `error`. Dodati test z lažnim strežnikom, ki ne odgovori. |
| CR-02 | **major – odvisno od načina gostovanja** | Varnost / dostop do podatkov | `server/index.js:54–169, 213–216` | API nima avtentikacije ali avtorizacije, strežnik pa se zažene brez izrecne omejitve gostiteljskega naslova. Če je proces dosegljiv iz nezaupanja vrednega omrežja, lahko drugi berejo interna gradiva in zapiske, brišejo gradiva ter sprožajo klice OpenAI, ki povzročajo stroške. Odsotnost prijave je sicer skladna z obsegom različice 1.0 v specifikaciji, ki aplikacijo določa za interno uporabo. | Za trenutno različico omejiti dostop na localhost ali zanesljivo interno omrežje oziroma uporabiti avtentikacijski reverse proxy. Pred javnim ali širše dostopnim gostovanjem dodati avtentikacijo in avtorizacijo. V navodilih za namestitev izrecno opozoriti na omrežno omejitev. |
| CR-03 | **minor** | Uporabniški vmesnik / asinhroni podatki | `client/src/views/Materials.jsx:35–46, 60–67` | Ob hitri menjavi tečaja lahko klic za prejšnji tečaj še teče, ko se začne klic za novega. Če starejši odgovor prispe zadnji, lahko prepiše seznam gradiv in `loadedCourseId` z zastarelimi podatki. | Uporabiti `AbortController` ali identifikator zaporedja zahtev in upoštevati samo odgovor zadnje zahteve. Dodati regresijski test za prekrivajoča se klica. |
| CR-04 | **minor** | Validacija / omejevanje porabe | `server/index.js:50, 62–68, 85–100, 158–160` | Imena tečajev in naslovov nimajo namenskih omejitev dolžine; prilepljeno besedilo lahko doseže 5 MiB, vprašanje pa je omejeno le s splošno omejitvijo JSON-parserja. To ni neposredna SQL-injection ranljivost, vendar lahko zelo dolgi naslovi ali vprašanja po nepotrebnem obremenijo shranjevanje in modelne storitve. | Določiti razumne poslovne omejitve za ime tečaja, naslov in vprašanje ter jih preverjati na strežniku. Omejitve prikazati tudi v obrazcih in vrniti dosledno napako 400. |
| CR-05 | **minor** | Konfiguracija razvoja | `client/vite.config.js:4–11` | Naslov proxy strežnika ima trdo kodirano ime gostitelja `localhost`, medtem ko `CLAUDE.md` pravi, naj se naslovi in konfiguracija berejo iz okolja. Vrata so sicer prebrana iz `PORT`. To lahko povzroči težave v razvojnem okolju, kjer strežnik ni na istem gostitelju. | Če je podprta oddaljena razvojna postavitev, dodati okoljsko spremenljivko za API origin/host in jo uporabiti pri proxyju. Če je localhost namerna omejitev specifikacije, jo dokumentirati kot izjemo. |
| CR-06 | **minor** | Kakovost RAG / odpornost na navodila v virih | `server/rag/answer.js:10–31` | Vsebina odlomkov in vprašanje sta poslana modelu kot uporabniško sporočilo. Poziv pravilno zahteva uporabo samo odlomkov, vendar ne obravnava izrecno morebitnih navodil, vdelanih v uvožena gradiva. Če gradivo vsebuje besedilo, ki model nagovarja k ignoriranju naloge, se lahko kakovost odgovora in citiranja poslabša. To je predvsem tveganje kakovosti modela, ne dokaz neposrednega izvajanja kode. | Jasneje označiti odlomke kot nezaupanja vredno citirano vsebino in dodati pravilo, naj model navodil znotraj odlomkov ne izvršuje. Dodati evalvacijska vprašanja z namerno zavajajočim besedilom v gradivu ter preveriti, da odgovori ostanejo vezani na vire. |

## Preverjene skladnosti in pojasnila

- **Pozivi modelu:** `NOTES_SYSTEM_PROMPT`, `MERGE_SYSTEM_PROMPT` in `ANSWER_SYSTEM_PROMPT` se ujemajo z besedilom v `docs/spec.md`; testi v `tests/notes.test.js` in `tests/rag.test.js` preverjajo to ujemanje.
- **SQL-injection:** v pregledanih API in podatkovnih modulih so vrednosti podane kot parametri SQLite (`?`), ne z vstavljanjem neposrednega vnosa v SQL.
- **Brisanje in doslednost podatkov:** `deleteMaterial()` izvede transakcijo, najprej izbriše vektorje in kose, nato gradivo. Zapiski in kosi so vezani na gradivo s `ON DELETE CASCADE`.
- **Uvoz:** strežnik sprejme TXT/SRT/VTT po končnici in omeji datoteke ter polja na 5 MiB. Končnica ni preverjanje dejanske vsebine datoteke, vendar je to v skladu z izrecno preprosto specifikacijo; pri strožjem varnostnem modelu bi bilo treba dodati vsebinsko preverjanje.
- **Obnovitev opravil:** `restoreJobs()` ponovno doda zapise s stanjem `processing` v vrsto. Testi preverjajo ponovno dodajanje, ne pa popolnega izklopa in zagona ločenega procesa.
- **OpenAI:** model se bere iz `OPENAI_MODEL`; interne ponovitve SDK so izklopljene, aplikacija pa ponavlja prehodne napake do treh dodatnih poskusov. Neuspehi se pretvorijo v berljiva sporočila.
- **Embeddings:** Ollama zahteve pošiljajo največ 32 besedil naenkrat; število vektorjev in dimenzija sta preverjena, vektorji pa normalizirani.
- **RAG kandidatni filter:** izbira 30 najbližjih kosov pred filtriranjem na tečaj je izrecno navedena v `docs/spec.md`. Test `tests/rag.test.js` preverja tudi, da kosi zunaj 30 kandidatov ne pridejo v rezultat. Pri iskanju brez filtra se vzame šest najbližjih kosov, nato se izločijo gradiva, ki niso `ready`; README to omejitev dokumentira. To ni uvrščeno med napake glede na trenutno specifikacijo, čeprav lahko vpliva na število virov.
- **Markdown:** vmesnik uporablja `react-markdown` brez vklopa surovega HTML-ja, kar zmanjša možnost XSS prek vsebine Markdown.
- **Vmesnik:** stanje obdelave se osvežuje na tri sekunde, v prikazu gradiva je vsebina privzeto skrajšana, napake pa so prikazane uporabniku.
- **Omejitev obsega:** PDF/DOCX, prijava uporabnikov in pravice niso del različice 1.0 po `docs/spec.md`; njihova odsotnost zato ni označena kot napaka.

## Testi, gradnja in odvisnosti

Tega okolja nisem mogel uporabiti za izvajanje ukazov v kloniranem repozitoriju. Zato ne trdim, da so testi ali gradnja uspešni:

- `npm test` — **ni zagnan**.
- `npm run build` — **ni zagnan**.
- `npm audit` — **ni zagnan**.
- `npm run eval` — **ni zagnan**; potrebuje konfigurirano bazo, resnična gradiva in delujočo Ollamo.

Testna zbirka pokriva konverzijo TXT/SRT/VTT, velikost uvoza, indeksiranje in brisanje, razrez kosov, dimenzije vektorjev, API vprašanj, obdelavo zapiskov in dobesedno ujemanje pozivov. Za zaključek pregleda je še vedno potrebno lokalno ali CI izvajanje zgornjih ukazov. Za varnost odvisnosti je posebej pomemben `npm audit`, ker statični pregled kode ne preveri znanih ranljivosti paketov.

## Pet najpomembnejših naslednjih korakov

1. Dodati časovno omejitev Ollama zahtev in test za visečo storitev, da vrsta opravil ne ostane blokirana.
2. Zagotoviti, da je API dosegljiv samo zaupanja vrednim uporabnikom/omrežju; pred širšo izpostavitvijo dodati avtentikacijo.
3. Preprečiti prepisovanje seznama gradiv z zastarelimi odgovori pri hitri menjavi tečajev.
4. Dodati omejitve dolžine za imena tečajev, naslove in vprašanja.
5. Izvesti `npm test`, `npm run build` in `npm audit` v lokalnem okolju ali CI ter rezultate dopisati v poročilo.
