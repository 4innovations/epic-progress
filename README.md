# epic-progress

Een mod voor Claude Code (desktop-app of terminal). Hij toont in een zijpaneel en in de statusregel hoe ver de Jira-Epic is waar het ticket van je sessie onder valt.

- Een voortgangsring en -balk per status (Done, In Review, In Progress, To Do). Won't Do telt niet mee.
- De statusregel, bijvoorbeeld `REV-4 ▰▰▰▰▱▱▱▱▱▱ 43% · nog 4 open ≈ 4 sessies`. Vuistregel: één sessie per ticket.
- De tickets van de Epic, met het ticket van je sessie gemarkeerd.
- Het paneel ververst na elke Jira-wijziging door Claude, en elke 15 minuten.

## Installeren

Je hebt nodig: Claude Code 2.1.286 of nieuwer, en in claude.ai de **Atlassian-connector**, gekoppeld aan je eigen site (Instellingen → Connectors → Atlassian).

```
claude plugin marketplace add 4innovations/epic-progress
claude plugin install epic-progress@epic-progress --config sites=<jouwsite> --config projects=<KEY>
```

- `sites`: de naam van je Atlassian-site. `jouwnaam` staat voor `jouwnaam.atlassian.net`. Meerdere sites scheid je met komma's.
- `projects`: de Jira-projectcodes waarvan je tickets en Epics wilt zien, bijvoorbeeld `REV` of `REV,WEB`.

Achteraf wijzigen kan in `~/.claude/settings.json`:

```json
"pluginConfigs": { "epic-progress@epic-progress": { "options": { "sites": "jouwnaam", "projects": "REV,WEB" } } }
```

Typ je `/epic WEB-12` terwijl WEB nog niet in je projecten staat, dan meldt de mod dat en geeft hij de regel die je moet toevoegen.

**Alleen in auto mode:** auto mode laat een mod niet zomaar bij Jira. Weigert hij, dan toont het paneel de exacte regel met een knop **Kopieer regel**. Zet die regel in `~/.claude/settings.json` onder `permissions.allow` en klik daarna op **Vernieuwen**. De regel geeft alleen leesrecht (zoeken in Jira). Schrijven in Jira gaat nog steeds via de gewone toestemmingscontrole.

## Gebruik

- **Eén sessie is één ticket.** Het ticket in de branchnaam (bijvoorbeeld `rev-12-…`) gaat voor. Zonder branch wordt het eerste ticket dat langskomt het sessieticket: een ticketcode in je bericht, of een ticket dat Claude in Jira wijzigt.
- `/epic` opent het paneel. `/epic REV-12` wisselt naar dat ticket en zet zijn Epic vast. `/epic <woorden>` zoekt een Epic op titel. `/epic auto` laat de mod weer het sessieticket volgen. `/epic uit` zet paneel en statusregel uit voor deze sessie.
- Vastzetten en uitzetten gelden per sessie. Kiezen in het paneel verandert niets in Jira.
- Tickets met het label `awaiting-field-test` tellen als Done, maar staan apart vermeld.

## Ontwikkelen

```
cd plugins/epic-progress
claude plugin test .
claude plugin validate .
```

Gebruik een `claude` van dezelfde versie als de desktop-app.

## Licentie

MIT, zie [LICENSE](LICENSE).
