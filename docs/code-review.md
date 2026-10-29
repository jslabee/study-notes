# Pregled kode – Study Notes

**Datum pregleda:** 29. 10. 2026  
**Pregledana veja:** `feature/scaffold` (privzeta veja ob pregledu)  
**Obseg:** statični pregled izvorne kode in primerjava z `CLAUDE.md` ter `docs/spec.md`. Obstoječa aplikacijska koda ni bila spreminjana.

## Povzetek

Aplikacija večinoma sledi načrtovani arhitekturi: uporablja parametrične SQL-poizvedbe, ločeno vrsto opravil, vektorsko indeksiranje in teste za ključne poti. Sistemska navodila za zapiske in RAG so v kodi kopirana dobesedno iz specifikacije, za kar obstajajo tudi testi.

Najpomembnejši problem je iskanje RAG: omejitev števila najbližjih vektorjev se uporabi **pred** filtriranjem na gradiva s stanjem `ready` oziroma na izbrani tečaj. Zato lahko API vrne manj kot šest virov ali celo nič, čeprav ustrezni viri obstajajo. Poleg tega klic Ollame nima časovne omejitve; ker se opravila izvajajo zaporedno, lahko nedokončan klic ustavi celotno vrsto. Aplikacija nima vgrajene avtentikacije, zato mora ostati omejena na zaupanja vredno okolje, kot predvideva specifikacija.

## Ugotovitve

| ID | Resnost | Področje | Datoteka in vrstice | Težava | Predlagani popravek |
|---|---|---|---|---|---|
| CR-01 | **major** | Pravilnost RAG / iskanje | `server/rag/search.js:15–33` | Poizvedba najprej izbere `k` najbližjih vektorjev iz celotne tabele, šele nato združi gradiva in odstrani tista, ki niso `ready`, oziroma filtrira izbrani tečaj. Neprimerni zadetki tako porabijo omejitev `k`. Posledica je manj kot šest virov ali prazen rezultat, čeprav v izbranem tečaju oziroma med pripravljenimi gradivi obstajajo ustrezni kosi. Test `tests/rag.test.js` trenutno potrjuje to zmanjšanje rezultatov namesto pričakovanega iskanja samo po uporabnih gradivih. | Zagotoviti, da je nabor kandidatov omejen na gradiva `ready` in po potrebi na izbrani tečaj, preden se določi končnih šest rezultatov. Če omejitev `sqlite-vec` otežuje filtriranje v KNN-poizvedbi, uporabiti strategijo kandidiranja, ki nadaljuje iskanje, dokler ne zbere šest ustreznih zadetkov, ali primerjati izvedljivo alternativo. Dodati test, kjer je veliko bližjih kosov iz drugih/nepripravljenih gradiv, pripravljeno gradivo pa mora vseeno vrniti zadetke. |
| CR-02 | **major** | Zanesljivost / obdelava v ozadju | `server/llm.js:118–126`; `server/jobs.js:49–71` | Klic `fetch()` na Ollamo nima `AbortSignal` oziroma časovne omejitve. Če storitev sprejme povezavo, vendar ne odgovori, se `indexMaterial()` ne zaključi. Ker `jobs.js` izvaja opravila eno za drugim, ostanejo za tem čakajoča indeksiranja in priprava zapiskov blokirani, uporabniški vmesnik pa lahko neskončno prikazuje `Processing`. | Dodati nastavljivo časovno omejitev za Ollama zahteve, pravilno obravnavati `AbortError` in prekiniti opravilo z jasnim sporočilom o napaki. Po potrebi dodati omejeno ponavljanje samo za prehodne napake; zagotoviti, da se status gradiva vedno preklopi v `error`, ko je zahteva dokončno neuspešna. Testirati strežnik, ki se ne odzove. |
| CR-03 | **major – pogojno glede na okolje** | Varnost / dostop do podatkov | `server/index.js:54–169` | API nima avtentikacije ali avtorizacije. Kdor lahko doseže strežnik, lahko bere vsa gradiva in zapiske, briše gradiva ter sproža klice OpenAI, ki lahko povzročijo stroške. `CLAUDE.md` in `docs/spec.md` sicer določata interno uporabo in izrecno izključujeta prijavo v različici 1.0, zato to ni odstopanje od funkcionalnega obsega, je pa pomembno tveganje pri napačni izpostavitvi omrežju. | Aplikacije ne izpostavljati javnemu internetu. Omejiti dostop na localhost ali zaupanja vredno interno omrežje in/ali pred API postaviti avtentikacijski reverse proxy. Pred vsako širšo uporabo dodati avtentikacijo in preverjanje pravic. V dokumentaciji jasno navesti, da aplikacija brez dodatne zaščite ni primerna za javno gostovanje. |
| CR-04 | **minor** | Uvoz / kakovost besedila | `server/materials/convert.js:25–38` | Pri podnapisih se vsaka vrstica z besedilom združi v en sam tok, odstavki pa se zaključijo šele, ko je zbranih vsaj 500 znakov in se trenutni cue konča s končnim ločilom. Kratki transkripti brez ločil ali s pogostimi kratkimi stavki zato lahko postanejo en sam dolg odstavek. To poslabša berljivost prikaza in lahko zmanjša kakovost razreza za zapiske. | Ohranjati meje izvornih blokov/cue-jev kot šibke meje odstavkov ali uporabiti bolj robustno pravilo, ki ne zahteva minimalne dolžine 500 znakov. Dodati primere kratkega transkripta, več govorcev in besedila brez ločil. |
| CR-05 | **minor** | Uporabniški vmesnik / asinhroni klici | `client/src/views/Materials.jsx:35–46, 60–67` | Pri hitrem menjavanju tečajev se lahko prekrivata dva klica `loadMaterials()`. Če starejši klic konča pozneje, lahko prepiše seznam gradiv novega tečaja in nastavi `loadedCourseId` na zastarel tečaj. | Ob menjavi tečaja preklicati prejšnji `fetch` z `AbortController` ali uporabiti števec zahtev in sprejeti samo rezultat zadnje zahteve. Dodati test oziroma ročno preverjanje s počasnim omrežjem. |
| CR-06 | **minor** | Validacija vhodov / omejevanje porabe | `server/index.js:85–100, 158–160` | Polja `title`, ime tečaja in vprašanje nimajo namenskih omejitev dolžine. Omejitev velikosti multipart polja sicer omeji posamezen prenos, vendar dopušča zelo velika imena in dolga vprašanja; ta se lahko shranijo v bazo ali pošljejo storitvam za vektorje in model. | Določiti razumne največje dolžine za ime tečaja, naslov in vprašanje ter jih preverjati na strežniku. Za predolge vrednosti vrniti `400` z jasnim sporočilom; omejitve po potrebi uskladiti z uporabniškim vmesnikom. |

## Primerjava s specifikacijo

- **Modelni pozivi:** `NOTES_SYSTEM_PROMPT`, `MERGE_SYSTEM_PROMPT` in `ANSWER_SYSTEM_PROMPT` so v kodi zapisani dobesedno; testi preverjajo ujemanje z bloki v `docs/spec.md`.
- **SQL-injection:** pregledane poizvedbe za uporabniške vrednosti uporabljajo parametre SQLite (`?`), ne sestavljajo SQL iz neposrednega vnosa.
- **Brisanje:** `deleteMaterial()` odstrani vektorje pred kosi in gradivom; zapiski in kosi imajo tuje ključe s kaskadnim brisanjem. To je skladno s posebnostjo `sqlite-vec`, ki nima tujih ključev.
- **Uvoz:** strežnik omejuje datoteke in polja na 5 MiB ter dovoljuje končnice TXT/SRT/VTT, kot zahteva specifikacija. Preverjanje vrste temelji na končnici datoteke, ne na vsebini; za interno aplikacijo je to omejena validacija, ne dokaz vrste datoteke.
- **Opravila ob ponovnem zagonu:** `restoreJobs()` ponovno doda gradiva in zapiske v stanju `processing` v vrsto.
- **Modeli in ponovitve:** OpenAI uporablja `OPENAI_MODEL`, izklopljene so interne ponovitve SDK-ja, implementirane pa so največ tri ponovitve pri prehodnih napakah. Embeddings uporabljajo nastavitve Ollame in pakete po največ 32 besedil.
- **Prikaz Markdown:** vmesnik uporablja `react-markdown` brez omogočanja surovega HTML-ja, kar zmanjša tveganje neposrednega XSS prek Markdown vsebine. Kljub temu je treba ohraniti to varno privzeto konfiguracijo.
- **Specifikacija in navodila:** `CLAUDE.md` zahteva, da se `docs/spec.md` in modelni pozivi ohranijo; poročilo je dodano kot ločena datoteka in ne spreminja teh dveh dokumentov.

## Preverjanje

**Testov, gradnje in varnostnega pregleda odvisnosti v tem okolju nisem mogel zagnati.** Dostop do repozitorija je omogočil branje in urejanje datotek prek GitHuba, ne pa izvajanja ukazov v kloniranem delovnem okolju. Zato spodnji rezultati niso predstavljeni kot uspešni ali neuspešni:

- `npm test` — ni zagnan.
- `npm run build` — ni zagnan.
- `npm audit` — ni zagnan.
- Evalvacija `npm run eval` z resničnimi gradivi in delujočo Ollamo — ni zagnana.

Pred združitvijo je treba te ukaze zagnati v lokalnem okolju ali CI. `npm run eval` potrebuje konfigurirane spremenljivke okolja, indeksirana gradiva in delujočo Ollamo; vzorčni evalvacijski rezultat zato ne bi bil zanesljiv brez ustreznih gradiv.

## Pet najpomembnejših popravkov

1. Popraviti iskanje RAG, da se končni zadetki izbirajo samo med gradivi `ready` in znotraj izbranega tečaja.
2. Dodati časovne omejitve Ollama zahtev in zagotoviti, da nedosegljiva ali viseča storitev ne blokira vrste opravil.
3. API omejiti na zaupanja vredno okolje; pred širšo izpostavitvijo dodati avtentikacijo.
4. Dodati strežniške omejitve dolžine za imena, naslove in vprašanja.
5. Preprečiti zastarele asinhrone odgovore pri hitrem preklapljanju tečajev ter dodati regresijski test.
