# Changelog

## Unreleased

- Statussen kloppen weer met de claude.ai-Atlassian-connector, die nu standaard een compact antwoord geeft zonder statuscategorie en parent: de mod vraagt bij elke koppeling `view: "full"`, en zonder `view` als een oudere connector dat niet kent.
- De Nederlandse status "Wordt beoordeeld" telt als In Review.

## 0.2.0 (09-10-2026)

- Eerste publieke versie.
- Optie `sites`: de Atlassian-sites waarop de mod je projecten zoekt (bijv. `jouwnaam` voor `jouwnaam.atlassian.net`).
- Leest ook via vaste Rovo-MCP-v2-koppelingen per site, als die geladen zijn; anders via de claude.ai-Atlassian-connector.
- Werkt met Windows-paden (groot zoekresultaat, configsleutel).

## 0.1.0

- Zijpaneel en statusregel met de voortgang van de Epic van het sessieticket; `/epic`-commando.
