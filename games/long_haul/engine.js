/* The Long Haul: rules engine.
 *
 * One module, loaded by the page (index.html) and by the balance simulation
 * (sim.js), so the simulation tests the game itself rather than a model of it.
 * No DOM, no libraries. Game state is plain JSON so the page can autosave it.
 *
 * All randomness is spent at setup (deck order, event order), so two tables
 * given the same seed draw the same cards and meet the same events, and differ
 * only in what the players decide. Bots use their own stream (botRng).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LongHaul = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- knobs --
  // Every magnitude here is invented for balance (spec §7). What is real is
  // the shape: sea > river and canal > road, the Hinterland cap, rail helping most where
  // there is no water, identical Hosts, state food vanishing with the state.
  const DEFAULTS = {
    rounds: 8,               // raised from 5 (Caleb, 2026-10-01). The setup screen can set 3 to 12
    hostRule: 'boost',       // 'boost': a Route pays 1 Trade, +1 more with your Host there (Caleb, 2026-09-28)
                             // 'gate': a Route pays Trade only with your Host at the far end
    handSize: 4,
    startHost: true,         // one card of every opening hand is a Host, so Paper is never dead (2026-10-01)
    hinterlandCap: 3,
    basraCap: 5,
    startHinterlands: 1,       // used only when startHinterlandsByGeo is null
    startPop: 1,
    foodPerPop: 2,
    tradePerPop: 1,
    cityFood: 1,
    cityTrade: 1,
    modeFood: { sea: 2, river: 1, canal: 1, road: 0, rail: 2 },
    railNoWaterBonus: 2,
    routeTrade: 1,
    boostBaseTrade: 1,
    maxRoutesPerPair: 2,
    seaAbilityTrade: 1,       // 'seaTrade': +Trade per Sea Route
    seaAbilityFood: 1,        // 'seaFood': +Food per Sea Route
    bourseFee: 1,             // 'bourseFees': +Trade per rival Host in your city
    tributeTrade: 1,          // 'tribute': +Trade a turn until the dynasty falls
    tributeFrom: 3,           // ...starting in this round
    startHinterlandsByGeo: { coast: 1, river: 1, inland: 2 },
    startHinterlandsByCity: { chitsbury: 3 },   // overrides the above. NB config objects merge, so {} here keeps a default
    startRoutes: [],               // e.g. [['barnacle', 'handthrow']]: Routes already open at setup
    boxSeaTrade: 1,
    paperPerHost: 1,
    stateFood: 2,
    songFood: 1,
    songTrade: 1,
    qhapaqFood: 1,
    elevatorIn: 2,
    elevatorOut: 1,
    capByGeo: { coast: 3, river: 3, inland: 5 },   // null: hinterlandCap everywhere
    siltTrade: 1,            // the dredging bill, per turn, once the harbors silt
    costs: { host: 1, paper: 1, state: 2, canal: 2, railway: 2, elevator: 2, bandits: 1, crown: 2 },
    // Every other card: one copy. A card a city starts with in play comes out of its count.
    counts: { hinterland: 14, route: 20, canal: 4, railway: 3, elevator: 2, bandits: 3, crown: 2 },
    excludeCards: [],        // card types left out of the deck. Qhapaq Ñan stays in unsourced (Caleb, 2026-09-28)
    swapDeadHinterlands: true,   // a Hinterland you can never play is swapped for a new card
    events: ['dynasty', 'conquest', 'banditsAll', 'box', 'silts', 'bourse', 'canalCloses'],   // one a round from round 2
    dynastyRounds: null,     // null: set from the number of rounds, by dynastyWindow()
  };

  // --------------------------------------------------------------- cities --
  // Whimsical names (Caleb, 2026-09-28), each modeled on a real case that the
  // debrief names. geo: 'coast' | 'river' | 'inland'. Coast and river are water.
  const CITIES = {
    barnacle: {
      name: 'Port Barnacle', model: 'Liverpool', geo: 'coast', ability: 'none',
      abilityText: 'No special power: you have the sea.',
      story: "Freeze England's roads and waterways as they stood in 1680, and a model shrinks the Manchester, Birmingham and Leeds of 1841 by a fifth to a quarter. Liverpool loses about 4%. It already had cheap water.",
      source: 'Alvarez-Palau et al., 2020',
    },
    chitsbury: {
      name: 'Chitsbury', model: 'Pingyao', geo: 'inland', ability: 'startPaper', extra: ['cheapHosts', 'cheapState', 'cheapRail'], start: ['shanxi'],
      abilityText: 'Starts with a Shanxi draft bank in play and 3 Hinterlands farmed. Your Hosts cost nothing; State cards and Railways cost you 1 less.',
      story: 'Pingyao was one of three Shanxi county towns, with Taigu and Qixian, where the draft banks kept their head offices.',
      source: 'Wang, 2024',
    },
    handthrow: {
      name: 'Handthrow', model: 'Antwerp', geo: 'coast', ability: 'freeHosts',
      abilityText: "Other cities' Hosts in Handthrow cost them nothing.",
      story: 'Antwerp gave foreign merchants houses of their own (the Hanse in 1468, the English in 1474) and built a Bourse for them to trade in.',
      source: 'Harreld, 2003',
    },
    grazing: {
      name: 'Much Grazing', model: "Chang'an", geo: 'inland', ability: 'startHerds', extra: ['cheapState', 'tribute'], start: ['herds'],
      abilityText: 'Starts with the Tang imperial herds in play. State cards cost you 1 less. From round 3, +1 Trade a turn in tribute. The dynasty falls takes the herds and the tribute.',
      story: "Tang Chang'an was fed sheep and goats sent in as tribute, tax and shipments from the imperial pastures. After the dynasty ended in 907, that supply went east to Kaifeng.",
      source: 'Guo et al., 2026',
    },
    // The laptop's two river cities at the default table.
    silo: {
      name: 'Silo Heights', model: 'Chicago', geo: 'river', ability: 'startElevator', start: ['elevator'],
      abilityText: 'Starts with a Grain elevator in play.',
      story: 'Three things arrived in Chicago together: the grain elevator, the grading of wheat, and futures trading at the Board of Trade.',
      source: 'Cronon, 1991',
    },
    letterbury: {
      name: 'Letterbury', model: 'Fustat', geo: 'river', ability: 'freePaper',
      // "Costs nothing" is a game device. What the corpus supports is the tie
      // between Fustat and paper, not any price (FLAVOR_SOURCES.md).
      abilityText: 'Paper costs you nothing.',
      story: 'Fustat sits on the receiving end of nearly every dated payment letter we met from the Cairo Geniza. Letters from Alexandria, Jerusalem and Damascus all point there.',
      source: 'Princeton Geniza Project, 2026',
    },
    // Spares. Sources not yet checked: not for class use.
    lockington: {
      name: 'Lockington', model: 'Manchester', geo: 'inland', ability: 'cheapCanal',
      abilityText: 'Your Canals cost 1 less.', source: null,
    },
    donkeyford: {
      name: 'Donkeyford', model: 'Assur', geo: 'inland', ability: 'firstHostFree',
      abilityText: 'Your first Host costs nothing.', source: 'Green et al., 2024',
    },
  };
  // Six cities a table (Caleb, 2026-10-01): four students, and the laptop plays
  // the two river cities, so the board has real rivers as well as canals.
  const DEFAULT_TABLE = ['barnacle', 'chitsbury', 'handthrow', 'grazing', 'silo', 'letterbury'];
  const DEFAULT_BOTS = [null, null, null, null, 'casual', 'casual'];

  // ---------------------------------------------------------------- cards --
  // target: 'none' | 'city' (another city) | 'roadRoute' (one of your Road Routes)
  //
  // Flavor text (Caleb, 2026-10-01): `def` says what the thing was, `story` gives
  // one line of its history. A def may be written from general knowledge, since
  // it only says what a word means (QUESTIONS.md D28). A story may not: every
  // one is paraphrased from the day notes, and FLAVOR_SOURCES.md records the
  // file and line behind it, with the cautions that shaped the wording.
  const host = (name, where, source, def, story) => ({ family: 'host', name, where, source, def, story, costKey: 'host', target: 'city' });
  const paper = (name, where, source, def, story) => ({ family: 'paper', name, where, source, def, story, costKey: 'paper', target: 'none' });
  const CARDS = {
    hinterland: { family: 'basic', basic: true, name: 'Hinterland', source: 'Gaastra et al., 2024', target: 'none',
      def: 'Hinterland: the countryside that feeds a city.',
      story: 'In the earliest cities of Mesopotamia and the Levant, the sheep and goats on the table were killed too young to have been bred in town. They had to keep coming in from the country.' },
    route: { family: 'basic', basic: true, name: 'Route', source: 'Flückiger et al., 2019', target: 'city',
      story: 'Roman freight by sea, river and road cost roughly 1 to 7.5 to 52.' },

    maiGida: host('Mai gida', 'Hausa market towns, 19th c.', 'Austin, 2004',
      'Mai gida: Hausa for the head of a house. Here, a landlord who takes in traders.',
      'Caravans stopping in Hausa market towns stayed with landlords of their own people, who introduced them to local partners and helped them make deals.'),
    huiguan: host('Huiguan', 'Linqing, 1466', 'Moll-Murata, 2008',
      'Huiguan: a hall, and the club behind it, for people from one home place living in another city.',
      'Cotton-cloth merchants from Jiading, Kunshan and Suzhou founded a guild at Linqing, a port on the Grand Canal, in 1466.'),
    cantonHall: host("Canton merchants' huiguan", 'Peking, 1712', 'Moll-Murata, 2008',
      'Huiguan: a hall for people from one home place living in another city.',
      'A group of Canton merchants built their own hall in Peking in 1712. They wanted to stay apart from the scholar-officials from Canton.'),
    kontor: host('Hanseatic Kontor', 'Bruges', 'Ewert & Selzer, 2016',
      'Kontor: a trading post of the Hanseatic League in a foreign city.',
      "At Bruges the Hansards weren't tied to one place. They lodged with hostellers across the city, who brokered their deals and could stand surety for their debts."),
    petershof: host('St. Petershof', 'Novgorod, closed 1494', 'Ewert & Selzer, 2016',
      "The Hanseatic League's post at Novgorod.",
      'Its rules forbade settling down. A merchant could come once a year, for the summer or the winter season, and he still had to travel with his goods.'),
    kanesh: host("Assur's merchants at Kanesh", 'c. 1950 to 1700 BCE', 'Green et al., 2024',
      'Kanesh: a city in Anatolia, roughly 1,000 km from Assur.',
      'About 24,000 clay tablets survive from Assyrian merchant households there: debt notes, partnership shares, family firms that ran for generations.'),
    khorRori: host('South Asian residents at Khor Rori', '1st c. CE', 'Abraham, 2023',
      'Khor Rori: an ancient port in South Arabia.',
      "Finds there include a Tamil-Brahmi inscription with an Indian name, two Indian coins and a bronze statuette. People from South Asia lived here. They weren't just passing through."),
    khaoSamKaeo: host('Indian artisans at Khao Sam Kaeo', 'Thailand', 'Abraham, 2023',
      'Khao Sam Kaeo: an ancient port in Thailand.',
      'Beads and metalwork made there with South Asian techniques suggest that Indian craftspeople had settled in and were making things for the local market.'),
    nationHouse: host('Antwerp nation house', 'the Hanse, 1468', 'Harreld, 2003',
      'Nation: merchants from one homeland with a house of their own in a foreign city.',
      "Antwerp's magistrates granted the Hansards a house on the Korenmarkt in 1468. The English got one in 1474."),
    multani: host('Multani agents at Bukhara', '1559 and 1561', 'Levi, 2004',
      'Multani: from Multan, a trading city in the Punjab.',
      'Legal records place merchants from Multan at Bukhara in 1559 and 1561. Their agents, posted to caravanserais in distant cities, were trained to issue and cash hundis.'),
    shahbandar: host('Shahbandar of Melaka', 'c. 1400 to 1511', 'Borschberg, 2020',
      'Shahbandar: Persian for harbor master, the official over foreign merchants in a port.',
      'He kept the weights and measures and settled disputes among the foreign merchants. By one account Melaka had four, each for merchants from one part of the world, and a foreigner often held the job.'),
    pochteca: host('Pochteca houses at Tochtepec', 'Late Postclassic Mexico', 'Paris, 2025',
      'Pochteca: the long-distance merchants of the Aztec world.',
      'Merchants from each of twelve cities kept houses at Tochtepec and lodged there together. Or so Sahagún was told, decades after the conquest.'),
    fiveHundred: host('The Five Hundred at Barus', 'Sumatra, 1088', 'Karashima & Subbarayalu, 2009',
      'The Five Hundred of the Thousand Directions: a body of South Indian merchants.',
      "A Tamil stone at Barus records the Five Hundred setting a fee in gold, which a ship's captain and crew paid before they could come ashore to trade."),
    sabao: host('Sogdian colony', "Tang Chang'an", 'Rong, 2025',
      'Sabao: the leader of a Sogdian merchant caravan.',
      'Sogdians came from Central Asia in caravans of two or three hundred people. Where they arrived, they founded a colony.'),

    suftaja: paper('Suftaja', 'Islamic world, 11th c.', 'Thompson, 2007',
      'Suftaja: a written order to pay, used across the medieval Islamic world.',
      'You paid a dealer in one town and took his note. His partner in another town paid it out in the same coin, so no money had to make the trip.'),
    shanxi: paper('Shanxi draft bank', 'Pingyao, Taigu and Qixian, 1823 to 1914', 'Wang, 2024',
      'Piaohao: a Shanxi draft bank.',
      'Silver went in at one branch and came out at another against a paper draft. Thirty-odd of these banks worked in at least forty places.'),
    hundi: paper('Hundi', 'Sanganer to Patna, 1676', 'Kashyap, 2002',
      'Hundi: a South Asian bill ordering payment in another city.',
      "In May 1676 a hundi for 20,000 rupees left Sanganer for Patna, carrying a ruler's revenue. 2,000 was cashed at Agra and the rest sent on by a fresh hundi."),
    nakarattar: paper('Nakarattar hundi', '19th and 20th c.', 'Rudner, 1994',
      'Nakarattar: a community of South Indian bankers.',
      'On the sixteenth of every Tamil month their bankers met in five cities at once, Madras, Colombo and Rangoon among them, and fixed the interest rate.'),
    riceBill: paper('Osaka rice bill', 'Japan, around 1700', 'Schaede, 1989',
      'Rice bill: a paper claim on rice stored in an Osaka warehouse.',
      "Lords shipped their tax rice to warehouses on the Osaka waterfront. An agent there kept the books and sent money on to cover the lord's bills in Edo."),
    datini: paper('Florentine branch accounts', 'Datini, 1382 to 1410', 'Padgett & McLean, 2006',
      'Current account: a running tally of what two branches owe each other.',
      "Datini's partnerships in Pisa, Florence, Genoa and Catalonia were separate firms on paper. The accounts kept between them let money move from city to city."),

    storehouses: { family: 'state', name: 'Royal storehouses', where: 'Persia, 509 to 494 BCE', source: 'Aperghis, 1999', costKey: 'state', target: 'none',
      story: 'Clay tablets from Persepolis show a network of royal storehouses collecting a tax in goods. One of them gave out roughly 37,000 liters of grain a year.' },
    herds: { family: 'state', name: 'Tang imperial herds', where: "Chang'an", source: 'Guo et al., 2026', costKey: 'state', target: 'none',
      story: "Sheep and goats came into Tang Chang'an from the north and west as tribute, tax and shipments from the imperial pastures." },
    basra: { family: 'state', name: "Basra's canals", where: '630s to 775 CE', source: 'Brown, 2022', costKey: 'state', target: 'none',
      story: 'Basra was founded in the 630s in a place with about 170 mm of rain a year. Its canals, one of them 31 km long, pushed farming up to 30 km inland.' },
    song: { family: 'state', name: 'Song administrative town', where: '1085', source: 'Han & Sng, 2026', costKey: 'state', target: 'none',
      def: 'Zhen: a town run by officials sent from the capital.',
      story: 'A register of 1085 lets us count roughly 560 of them. The Song state put them at commercial nodes, where the trade already was.' },
    qhapaq: { family: 'state', name: 'Qhapaq Ñan', where: 'The Andes', source: null, costKey: 'state', target: 'none',
      def: 'Qhapaq Ñan: the road system of the Inka state.' },   // no story: uncited by Caleb's ruling of 2026-09-28

    canal: { family: 'steam', name: 'Canal', source: 'Alvarez-Palau et al., 2020; Thomas, 1949', costKey: 'canal', target: 'roadRoute',
      story: "A model that freezes England's roads and waterways as they stood in 1680 makes the Manchester of 1841 about a fifth smaller. In 1854 a ton went from New York to Chicago by the Erie Canal and the Lakes for $4.76." },
    railway: { family: 'steam', name: 'Railway', source: 'Bogart et al., 2024', costKey: 'railway', target: 'roadRoute',
      story: 'In India, carrying a ton one kilometer cost about 0.2 rupees before the railway and about 0.015 rupees on it.' },
    elevator: { family: 'steam', name: 'Grain elevator', source: 'Cronon, 1991', costKey: 'elevator', target: 'none',
      story: "In Chicago, wheat poured into an elevator stopped being one farmer's sacks. It became so many bushels of a grade, and you could sell it before it was grown." },

    bandits: { family: 'event', name: 'Bandits', source: 'Wang, 2024', costKey: 'bandits', target: 'city',
      story: 'A draft bank took in silver at one branch and paid it out at another, so the metal itself never took the road. That is why Paper protects you here.' },
    crown: { family: 'event', name: 'Crown prohibition', source: 'Bonialian, 2023', costKey: 'crown', target: 'city',
      story: 'From 1580 to 1630, agents called peruleros turned Potosí silver into Chinese goods at Manila. The Spanish crown had prohibited the trade, and it ran alongside the ban anyway.' },
  };
  const PERMANENT = new Set(['paper', 'state', 'steam']);   // families that stay in your tableau

  // Rules text depends on the Host rule, so it is generated, not stored.
  function cardText(type, cfg) {
    const c = cfg || DEFAULTS;
    const fam = CARDS[type].family;
    if (fam === 'host') return c.hostRule === 'gate'
      ? 'Place in another city. Routes into it pay you 1 Trade. Survives The dynasty falls.'
      : 'Place in another city. Routes into it pay you +1 Trade. Survives The dynasty falls.';
    if (fam === 'paper') return '+1 Trade each turn for every city where you have a Host. Bandits can\'t touch your Trade.';
    switch (type) {
      case 'hinterland': return c.capByGeo
        ? `+1 Food each turn. At most ${c.capByGeo.coast} for a coastal city, ${c.capByGeo.inland} for an inland one.`
        : `+1 Food each turn. At most ${c.hinterlandCap} per city.`;
      case 'route': return (c.hostRule === 'gate'
        ? 'Join your city to another; both collect. Sea: +2 Food each. River: +1. Road: none. Pays Trade only to a city with a Host at the far end.'
        : 'Join your city to another; both collect. Sea: +2 Food each. River: +1. Road: none. +1 Trade each, +1 more with a Host at the far end.');
      case 'storehouses': return `+${c.stateFood} Food each turn, fed by the king's stores. Destroyed if the dynasty falls.`;
      case 'herds': return `+${c.stateFood} Food each turn. Destroyed if the dynasty falls.`;
      case 'basra': return `Your Hinterland cap rises to ${c.basraCap}. Destroyed if the dynasty falls, and the extra fields with it.`;
      case 'song': return `Play only if your city has 2+ Routes. +${c.songFood} Food, +${c.songTrade} Trade each turn. Destroyed if the dynasty falls.`;
      case 'qhapaq': return `Your Road Routes carry ${c.qhapaqFood} Food each: the state moves it. Destroyed if the dynasty falls.`;
      case 'canal': return `Dig a Canal along one of your Road Routes. From then on it carries ${c.modeFood.canal} Food to each end.`;
      case 'railway': return `Upgrade one of your Road Routes to Rail: +${c.modeFood.rail} Food each end, +${c.railNoWaterBonus} more to an end with no Sea, River or Canal Routes.`;
      case 'elevator': return `Once a turn, turn ${c.elevatorIn} Food into ${c.elevatorOut} Trade.`;
      case 'bandits': return "Target city collects no Trade from its Road Routes on its next turn, unless it holds Paper.";
      case 'crown': return 'Next turn, the target collects Trade only through its Hosts: Routes into cities where it has a Host, and Paper.';
    }
    return '';
  }

  // ---------------------------------------------------------------- events --
  const EVENTS = {
    dynasty: { name: 'The dynasty falls', text: 'Every State card is destroyed. Hosts stay: the merchant communities outlast the regime.', source: 'Guo et al., 2026; Abraham, 2023',
      story: "After the Tang fell in 907, the state's herds went east to Kaifeng, and Chang'an was left with households keeping a few animals each. Around the Indian Ocean, resident merchant communities outlasted one regime after another." },
    conquest: { name: 'Conquest redirects the caravans', text: 'Road Routes pay nothing this round.', source: 'Mattingly, Sterry & Edwards, 2015', round: true,
      story: 'Zuwīla, in the Libyan Sahara, lived on the caravan trade across the desert. The Kānimi conquest of 1258 sent that trade elsewhere.' },
    canalCloses: { name: 'The Grand Canal closes, 1826', text: 'River and Canal Routes pay nothing this round.', source: 'Chen, Li & Yao, 2024', round: true,
      story: 'Severe flooding in 1825, where the Huai meets the Yellow River, closed the Grand Canal the next year. Afterwards, grain prices in the canal towns stopped moving together the way they had.' },
    silts: { name: 'The harbors silt up', text: 'Keeping a harbor open is a bill that never stops: from now on, every coastal city pays 1 Trade a turn to dredge.', source: 'Blömer et al., 2025',
      story: 'Seleucia in Pieria fought the silt in its harbor with a tunnel 120 m long, cut by the Roman army. The cost of that fight, and earthquakes, are blamed for its decline. By the late 600s the city was largely abandoned.' },
    bourse: { name: 'The Bourse is copied', text: "London and Amsterdam copy Antwerp's exchange: from now on, Hosts cost nothing anywhere.", source: 'Harreld, 2003',
      story: "London's Exchange took the Antwerp Bourse as its model, and Amsterdam's exchange was modeled on both." },
    banditsAll: { name: 'Bandits on every road', text: 'This round, no city collects Trade from Road Routes unless it holds Paper.', source: 'Wang, 2024', round: true,
      story: 'Before the draft, paying a debt in another city meant shipping the silver itself. Paper let the metal stay home.' },
    box: { name: 'The box arrives, 1956', text: 'From now on, Sea Routes pay +1 Trade to each end.', source: 'Bernhofen et al., 2013',
      story: 'On April 26, 1956 the Ideal-X sailed from Port Newark to Houston carrying containers. One estimate ties the box to far more trade growth among rich countries, twenty years on, than membership in any trade agreement.' },
  };

  // ------------------------------------------------------------------- rng --
  function mulberry(seed) { return seed >>> 0; }
  function next(stateObj, key) {
    let t = (stateObj[key] = (stateObj[key] + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function shuffle(arr, st, key) {
    for (let k = arr.length - 1; k > 0; k--) {
      const j = Math.floor(next(st, key) * (k + 1));
      [arr[k], arr[j]] = [arr[j], arr[k]];
    }
    return arr;
  }

  // ------------------------------------------------------------------ setup --
  function mergeCfg(over) {
    const c = JSON.parse(JSON.stringify(DEFAULTS));
    if (over) for (const k of Object.keys(over)) {
      if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k])) c[k] = Object.assign(c[k] || {}, over[k]);
      else c[k] = over[k];
    }
    return c;
  }

  // The two rounds in which the dynasty may fall. A short game keeps it to the
  // last two rounds; a longer one leaves time to rebuild: 5 rounds gives 4 or
  // 5 (the first version of the game), 8 gives 5 or 6, 12 gives 6 or 7.
  function dynastyWindow(rounds) {
    const second = rounds - Math.max(0, Math.round((rounds - 5) * 2 / 3));
    return [Math.max(2, second - 1), Math.max(2, second)];
  }

  function newGame(opts) {
    opts = opts || {};
    const cfg = mergeCfg(opts.config);
    if (!cfg.dynastyRounds || !cfg.dynastyRounds.length) cfg.dynastyRounds = dynastyWindow(cfg.rounds);
    const keys = opts.cities || DEFAULT_TABLE;
    const st = {
      v: 2, cfg, seed: opts.seed >>> 0, rng: mulberry(opts.seed || 1), botRng: mulberry((opts.seed || 1) ^ 0x9e3779b9),
      round: 1, active: 0, over: false, quiet: !!opts.quiet,
      cards: {}, deck: [], discard: [], nextUid: 1,
      cities: [], routes: [], hosts: [], nextRoute: 1,
      eventPlan: {}, roundEffect: null, box: false, dynastyFallen: false, lastEvent: null,
      log: [], results: null,
    };
    const mk = type => { const uid = 'c' + (st.nextUid++); st.cards[uid] = { uid, type }; return uid; };

    // Deck: counts for the multiples, one of everything else, minus what the
    // cities start with in play and anything excluded.
    const starts = keys.flatMap(k => CITIES[k].start || []);
    for (const type of Object.keys(CARDS)) {
      if (cfg.excludeCards.includes(type)) continue;
      const n = (cfg.counts[type] || 1) - starts.filter(t => t === type).length;
      for (let k = 0; k < n; k++) st.deck.push(mk(type));
    }
    shuffle(st.deck, st, 'rng');

    keys.forEach((k, i) => {
      const def = CITIES[k];
      st.cities.push({
        i, key: k, name: def.name, model: def.model, geo: def.geo,
        abilities: ((cfg.abilities && cfg.abilities[k]) || [def.ability].concat(def.extra || [])).concat((cfg.bonus && cfg.bonus[k]) || []),
        bot: opts.bots ? opts.bots[i] || null : null,
        pop: cfg.startPop, hand: [], tableau: [],
        hinterlands: (cfg.startHinterlandsByCity && cfg.startHinterlandsByCity[k]) ||
          (cfg.startHinterlandsByGeo ? cfg.startHinterlandsByGeo[def.geo] : cfg.startHinterlands),
        food: 0, trade: 0, basicPlayed: false, elevatorUsed: false, hostsPlaced: 0,
        flags: { bandits: false, crown: false },
        stats: { popByRound: [], own: 0, routes: 0, state: 0, lost: [], played: {}, limitedBy: { food: 0, trade: 0, none: 0 } },
      });
    });
    st.cities.forEach(c => (CITIES[c.key].start || []).forEach(t => c.tableau.push(mk(t))));
    for (const [x, y] of cfg.startRoutes || []) {
      const a = keys.indexOf(x), b = keys.indexOf(y);
      if (a < 0 || b < 0) continue;
      const mode = geoMode(st, a, b);
      st.routes.push({ id: 'r' + (st.nextRoute++), a, b, mode, built: mode });
    }
    // Opening hands. With startHost, each city's first card is the next Host in
    // the deck: Paper pays per Host city, so Paper with no Host does nothing.
    let dealt = 0;
    if (cfg.startHost) {
      st.cities.forEach(c => {
        const k = st.deck.findIndex(u => CARDS[st.cards[u].type].family === 'host');
        if (k >= 0) c.hand.push(st.deck.splice(k, 1)[0]);
      });
      dealt = 1;
    }
    for (let k = dealt; k < cfg.handSize; k++) st.cities.forEach(c => draw(st, c));

    // Event plan: The dynasty falls always happens, in a random round from
    // the dynastyRounds list; the other rounds from 2 on draw from the rest.
    const pool = shuffle(cfg.events.filter(e => e !== 'dynasty'), st, 'rng');
    const dynRound = cfg.events.includes('dynasty')
      ? cfg.dynastyRounds[Math.floor(next(st, 'rng') * cfg.dynastyRounds.length)] : null;
    // In a game with more rounds than events, the events are spread evenly
    // across it and the rounds between are quiet.
    let slots = [];
    for (let r = 2; r <= cfg.rounds; r++) {
      if (r === dynRound) st.eventPlan[r] = 'dynasty';
      else slots.push(r);
    }
    const n = pool.length;
    if (slots.length > n) slots = n < 2 ? slots.slice(0, n) : Array.from({ length: n }, (_, k) => slots[Math.round(k * (slots.length - 1) / (n - 1))]);
    for (const r of slots) if (pool.length) st.eventPlan[r] = pool.pop();

    log(st, 'setup', `${st.cities.length} cities, one deck. Round 1 begins.`);
    startTurn(st);
    return st;
  }

  // Played Hinterlands, Routes and hand events go to the discard pile, which is
  // shuffled back in if the deck runs out late in a long game.
  function draw(st, city) {
    if (!st.deck.length && st.discard && st.discard.length) {
      st.deck = shuffle(st.discard, st, 'rng');
      st.discard = [];
    }
    if (st.deck.length) city.hand.push(st.deck.shift());
  }

  function log(st, kind, text, cityIdx, card) {
    if (st.quiet) return;
    const e = { r: st.round, c: cityIdx === undefined ? null : cityIdx, k: kind, t: text };
    if (card) e.card = card;   // the card just played, so the page can show its story
    st.log.push(e);
  }

  // --------------------------------------------------------------- queries --
  const cardType = (st, uid) => st.cards[uid].type;
  const has = (city, ab) => city.abilities.includes(ab);
  const hasHost = (st, owner, city) => st.hosts.some(h => h.owner === owner && h.city === city);
  const hostCities = (st, owner) => new Set(st.hosts.filter(h => h.owner === owner).map(h => h.city)).size;
  const tableauTypes = (st, i) => st.cities[i].tableau.map(u => cardType(st, u));
  const hasPaper = (st, i) => tableauTypes(st, i).some(t => CARDS[t].family === 'paper');
  const routesOf = (st, i) => st.routes.filter(r => r.a === i || r.b === i);
  const otherEnd = (r, i) => (r.a === i ? r.b : r.a);
  const isWaterGeo = g => g === 'coast' || g === 'river';
  const hasWaterRoute = (st, i) => routesOf(st, i).some(r => r.mode === 'sea' || r.mode === 'river' || r.mode === 'canal');
  const cap = (st, i) => {
    const base = st.cfg.capByGeo ? st.cfg.capByGeo[st.cities[i].geo] : st.cfg.hinterlandCap;
    return tableauTypes(st, i).includes('basra') ? base + (st.cfg.basraCap - st.cfg.hinterlandCap) : base;
  };

  function geoMode(st, a, b) {
    const ga = st.cities[a].geo, gb = st.cities[b].geo;
    if (ga === 'coast' && gb === 'coast') return 'sea';
    if (isWaterGeo(ga) && isWaterGeo(gb)) return 'river';
    return 'road';
  }

  function costOf(st, i, type, target) {
    const cfg = st.cfg, me = st.cities[i], def = CARDS[type];
    if (def.basic) return 0;
    let c = cfg.costs[def.costKey];
    if (def.family === 'host') {
      if (st.bourse) c = 0;
      if (target !== undefined && target !== null && has(st.cities[target], 'freeHosts')) c = 0;
      if (has(me, 'firstHostFree') && me.hostsPlaced === 0) c = 0;
      if (has(me, 'cheapHosts')) c = 0;
    }
    if (def.family === 'paper' && has(me, 'freePaper')) c = 0;
    if (type === 'canal' && has(me, 'cheapCanal')) c = Math.max(0, c - 1);
    if (def.family === 'state' && has(me, 'cheapState')) c = Math.max(0, c - 1);
    if (type === 'railway' && has(me, 'cheapRail')) c = Math.max(0, c - 1);
    return c;
  }

  /* What city i collects. mode:
   *   'collect'  what it actually collects now (its pending Bandits/Crown, this round's event)
   *   'next'     what it will collect on its next turn (for bots judging an attack)
   *   'steady'   a normal turn: no one-shot effects (for bots judging an investment)
   * stateAlive: override whether State cards count (bots price The dynasty falls). */
  function income(st, i, mode, stateAlive) {
    const cfg = st.cfg, me = st.cities[i];
    const oneShots = mode !== 'steady';
    const roundEff = oneShots && (mode === 'collect' || st.active <= i || st.round === 0) ? st.roundEffect : null;
    const paperHeld = hasPaper(st, i);
    const bandit = oneShots && (me.flags.bandits || roundEff === 'banditsAll') && !paperHeld;
    const crown = oneShots && me.flags.crown;
    const camels = roundEff === 'conquest';
    const shut = roundEff === 'canalCloses';
    const types = tableauTypes(st, i);
    const alive = stateAlive === undefined ? true : stateAlive;
    const lines = [];
    let own = cfg.cityFood + me.hinterlands, stateF = 0, routeF = 0, trade = 0, lostT = 0, lostF = 0;

    const cityT = crown ? 0 : cfg.cityTrade;
    lostT += cfg.cityTrade - cityT; trade += cityT;
    lines.push({ what: 'city', food: cfg.cityFood, trade: cityT, note: crown ? 'crown' : null });
    if (me.hinterlands) lines.push({ what: 'hinterlands', n: me.hinterlands, food: me.hinterlands, trade: 0 });

    let qhapaq = false;
    for (const t of types) {
      const fam = CARDS[t].family;
      if (fam === 'state' && !alive) continue;
      if (t === 'storehouses' || t === 'herds') { stateF += cfg.stateFood; lines.push({ what: t, food: cfg.stateFood, trade: 0 }); }
      if (t === 'song') {
        const tt = crown ? 0 : cfg.songTrade; lostT += cfg.songTrade - tt;
        stateF += cfg.songFood; trade += tt; lines.push({ what: t, food: cfg.songFood, trade: tt });
      }
      if (t === 'qhapaq') qhapaq = true;
    }

    const noWater = !hasWaterRoute(st, i);
    for (const r of routesOf(st, i)) {
      const o = otherEnd(r, i), h = hasHost(st, i, o);
      let f = r.mode === 'rail' ? cfg.modeFood.rail + (noWater ? cfg.railNoWaterBonus : 0) : cfg.modeFood[r.mode];
      if (r.mode === 'road' && qhapaq) f += cfg.qhapaqFood;
      if (r.mode === 'sea' && has(me, 'seaFood')) f += cfg.seaAbilityFood;
      let t = cfg.hostRule === 'gate' ? (h ? cfg.routeTrade : 0) : cfg.boostBaseTrade + (h ? cfg.routeTrade : 0);
      if (r.mode === 'sea') {
        if (has(me, 'seaTrade')) t += cfg.seaAbilityTrade;
        if (st.box) t += cfg.boxSeaTrade;
      }
      const f0 = f, t0 = t, notes = [];
      if (camels && r.mode === 'road') { f = 0; t = 0; notes.push('camels'); }
      if (shut && (r.mode === 'river' || r.mode === 'canal')) { f = 0; t = 0; notes.push('closure'); }
      if (bandit && r.mode === 'road' && t) { t = 0; notes.push('bandits'); }
      if (crown && !h && t) { t = 0; notes.push('crown'); }
      lostF += f0 - f; lostT += t0 - t;
      routeF += f; trade += t;
      lines.push({ what: 'route', route: r.id, mode: r.mode, to: o, host: h, food: f, trade: t, notes });
    }

    const nPaper = types.filter(t => CARDS[t].family === 'paper').length;
    if (nPaper) {
      const pt = nPaper * hostCities(st, i) * cfg.paperPerHost;
      trade += pt; lines.push({ what: 'paper', n: nPaper, hostCities: hostCities(st, i), food: 0, trade: pt });
    }
    if (has(me, 'seaPort') && routesOf(st, i).some(r => r.mode === 'sea')) {
      const tt = crown ? 0 : 1; lostT += 1 - tt;
      trade += tt; lines.push({ what: 'seaPort', food: 0, trade: tt });
    }
    if (has(me, 'bourseFees')) {
      const n = st.hosts.filter(h => h.city === i && h.owner !== i).length;
      const ft = crown ? 0 : n * cfg.bourseFee; lostT += n * cfg.bourseFee - ft;
      if (n) { trade += ft; lines.push({ what: 'bourseFees', n, food: 0, trade: ft }); }
    }
    if (has(me, 'tribute') && alive && !st.dynastyFallen && st.round >= cfg.tributeFrom) {
      const tt = crown ? 0 : cfg.tributeTrade; lostT += cfg.tributeTrade - tt;
      trade += tt; lines.push({ what: 'tribute', food: 0, trade: tt });
    }
    if (st.silted && me.geo === 'coast') {
      const d = Math.min(trade, cfg.siltTrade);
      trade -= d; lines.push({ what: 'dredging', food: 0, trade: -d });
    }
    return { food: own + stateF + routeF, trade, own, stateF, routeF, lostF, lostT, lines, bandit, crown, camels, shut };
  }

  // ------------------------------------------------------------ legality --
  const no = why => ({ ok: false, why });
  const yes = { ok: true };

  function canPlay(st, uid, target) {
    if (st.over) return no('The game is over.');
    const i = st.active, me = st.cities[i];
    if (!me.hand.includes(uid)) return no('That card is not in your hand.');
    const type = cardType(st, uid), def = CARDS[type], cfg = st.cfg;
    if (def.basic && me.basicPlayed) return no('One Hinterland or Route a turn, and you have played yours.');
    const needsCity = def.target === 'city', needsRoad = def.target === 'roadRoute';
    if (needsCity && (target === undefined || target === null)) return no('Choose a city.');
    if (needsCity && (target === i || !st.cities[target])) return no('Choose another city.');
    if (needsRoad) {
      const r = st.routes.find(x => x.id === target);
      if (!r || (r.a !== i && r.b !== i)) return no('Choose one of your Routes.');
      if (r.mode !== 'road') return no(`That Route already runs by ${r.mode}. Only a Road can be upgraded.`);
    }
    const cost = costOf(st, i, type, target);
    if (cost > me.trade) return no(`Costs ${cost} Trade and you have ${me.trade}. Unspent Trade is lost each turn, so it can't be saved up.`);

    switch (type) {
      case 'hinterland':
        if (me.hinterlands >= cap(st, i)) return no(`A city can farm only the land within reach: ${cap(st, i)} Hinterlands is the cap.`);
        return yes;
      case 'route': {
        const n = st.routes.filter(r => (r.a === i && r.b === target) || (r.b === i && r.a === target)).length;
        if (n >= cfg.maxRoutesPerPair) return no(`${cfg.maxRoutesPerPair} Routes already join you to ${st.cities[target].name}.`);
        return yes;
      }
      case 'song':
        if (routesOf(st, i).length < 2) return no('The state put its towns where trade already ran: you need 2 Routes first.');
        return yes;
    }
    if (def.family === 'host' && hasHost(st, i, target)) return no(`Your merchants already live in ${st.cities[target].name}.`);
    return yes;
  }

  // Every legal target for a card in the active hand ([null] for untargeted).
  function targets(st, uid) {
    const i = st.active, def = CARDS[cardType(st, uid)];
    let cands;
    if (def.target === 'city') cands = st.cities.map(c => c.i).filter(j => j !== i);
    else if (def.target === 'roadRoute') cands = routesOf(st, i).filter(r => r.mode === 'road').map(r => r.id);
    else cands = [null];
    return cands.filter(t => canPlay(st, uid, t).ok);
  }

  // Why a card can't be played at all, or null if it can be somewhere.
  function whyNot(st, uid) {
    if (targets(st, uid).length) return null;
    const i = st.active, type = cardType(st, uid), def = CARDS[type];
    if (def.target === 'city') {
      if (def.family === 'host' && st.cities.every(c => c.i === i || hasHost(st, i, c.i)))
        return 'Your merchants already live in every other city.';
      if (type === 'route' && !st.cities[i].basicPlayed) return 'Every city is already joined to you by the most Routes allowed.';
      const trial = st.cities.find(c => c.i !== i);
      return canPlay(st, uid, trial.i).why;
    }
    if (def.target === 'roadRoute') {
      const roads = routesOf(st, i).filter(r => r.mode === 'road');
      if (!roads.length) return `${def.name} upgrades a Road, and you have no Road Route.`;
      return canPlay(st, uid, roads[0].id).why;
    }
    return canPlay(st, uid, null).why;
  }

  // ---------------------------------------------------------------- moves --
  function play(st, uid, target) {
    const chk = canPlay(st, uid, target);
    if (!chk.ok) return chk;
    const i = st.active, me = st.cities[i], type = cardType(st, uid), def = CARDS[type], cfg = st.cfg;
    const cost = costOf(st, i, type, target);
    me.trade -= cost;
    me.hand.splice(me.hand.indexOf(uid), 1);
    if (def.basic) me.basicPlayed = true;
    if (def.basic || def.family === 'event') st.discard.push(uid);
    me.stats.played[def.family] = (me.stats.played[def.family] || 0) + 1;
    const T = target !== null && target !== undefined && def.target === 'city' ? st.cities[target] : null;

    switch (def.family) {
      case 'basic':
        if (type === 'hinterland') {
          me.hinterlands++;
          log(st, 'play', `${me.name} brought a new Hinterland under the plow: +1 Food a turn.`, i, type);
        } else {
          const mode = geoMode(st, i, target);
          st.routes.push({ id: 'r' + (st.nextRoute++), a: i, b: target, mode, built: mode });
          const why = { sea: 'both on the coast, so it goes by sea: +2 Food each, and sea freight is cheap',
            river: 'both on water, so it goes by river: +1 Food each',
            road: 'one of them is inland, so it goes by road, and a road carries no bulk food' }[mode];
          log(st, 'play', `${me.name} opened a Route to ${T.name}: ${why}.`, i, type);
        }
        break;
      case 'host':
        st.hosts.push({ uid, owner: i, city: target, type });
        me.hostsPlaced++;
        log(st, 'play', `${me.name}'s merchants settled in ${T.name} (${def.name}). Someone there will now vouch for them.`, i, type);
        break;
      case 'event':
        if (type === 'bandits') {
          T.flags.bandits = true;
          log(st, 'play', `${me.name} set Bandits on ${T.name}'s roads: no Road Trade on its next turn unless it holds Paper.`, i, type);
        } else {
          T.flags.crown = true;
          log(st, 'play', `${me.name} had the Crown prohibit ${T.name}'s trade: next turn it collects Trade only through its Hosts.`, i, type);
        }
        break;
      default:   // permanents
        if (type === 'canal' || type === 'railway') {
          const r = st.routes.find(x => x.id === target);
          r.mode = type === 'canal' ? 'canal' : 'rail';
          const o = st.cities[otherEnd(r, i)];
          log(st, 'play', type === 'canal'
            ? `${me.name} dug a Canal along its road to ${o.name}: +${cfg.modeFood.canal} Food each end from now on.`
            : `${me.name} laid a Railway to ${o.name}. Rail helps most where there is no water.`, i, type);
        } else {
          log(st, 'play', `${me.name} played ${def.name}.`, i, type);
        }
        me.tableau.push(uid);
    }
    return { ok: true };
  }

  function canElevate(st) {
    const me = st.cities[st.active];
    return !st.over && tableauTypes(st, st.active).includes('elevator') && !me.elevatorUsed && me.food >= st.cfg.elevatorIn;
  }
  function useElevator(st, auto) {
    if (!canElevate(st)) return no('The elevator has run once this turn, or there is not enough Food.');
    const me = st.cities[st.active];
    me.food -= st.cfg.elevatorIn; me.trade += st.cfg.elevatorOut; me.elevatorUsed = true;
    log(st, 'play', `${me.name}'s Grain elevator turned ${st.cfg.elevatorIn} surplus Food into ${st.cfg.elevatorOut} Trade${auto ? ' at the end of the turn' : ''}.`, st.active);
    return { ok: true };
  }

  const growthOf = (st, food, trade) => Math.max(0, Math.min(Math.floor(food / st.cfg.foodPerPop), Math.floor(trade / st.cfg.tradePerPop)));

  // What End turn will do: used by the page's preview and by endTurn itself.
  function growthPreview(st) {
    const me = st.cities[st.active];
    let f = me.food, t = me.trade, elev = false;
    if (tableauTypes(st, st.active).includes('elevator') && !me.elevatorUsed && f >= st.cfg.elevatorIn &&
        growthOf(st, f - st.cfg.elevatorIn, t + st.cfg.elevatorOut) > growthOf(st, f, t)) {
      f -= st.cfg.elevatorIn; t += st.cfg.elevatorOut; elev = true;
    }
    const g = growthOf(st, f, t);
    return { grow: g, food: g * st.cfg.foodPerPop, trade: g * st.cfg.tradePerPop,
      wasteFood: f - g * st.cfg.foodPerPop, wasteTrade: t - g * st.cfg.tradePerPop, elevator: elev };
  }

  function endTurn(st) {
    if (st.over) return no('The game is over.');
    const i = st.active, me = st.cities[i];
    const gp = growthPreview(st);
    if (gp.elevator) useElevator(st, true);
    me.pop += gp.grow;
    const fLeft = me.food - gp.food, tLeft = me.trade - gp.trade;
    me.stats.limitedBy[gp.grow === 0 && !me.food && !me.trade ? 'none' : (fLeft >= st.cfg.foodPerPop ? 'trade' : tLeft >= st.cfg.tradePerPop ? 'food' : 'none')]++;
    log(st, 'grow', gp.grow
      ? `${me.name} grew by ${gp.grow} (spent ${gp.food} Food and ${gp.trade} Trade).${fLeft || tLeft ? ` ${[fLeft ? fLeft + ' Food' : '', tLeft ? tLeft + ' Trade' : ''].filter(Boolean).join(' and ')} went to waste.` : ''}`
      : `${me.name} did not grow this turn: growth needs ${st.cfg.foodPerPop} Food and ${st.cfg.tradePerPop} Trade together.`, i);
    me.food = 0; me.trade = 0; me.basicPlayed = false; me.elevatorUsed = false;
    if (st.cfg.swapDeadHinterlands && me.hinterlands >= cap(st, i)) {
      for (const uid of me.hand.slice()) {
        if (cardType(st, uid) !== 'hinterland' || !st.deck.length) continue;
        me.hand.splice(me.hand.indexOf(uid), 1);
        st.discard.push(uid);
        draw(st, me);
        log(st, 'swap', `${me.name} already farms all the land within reach, so its spare Hinterland was swapped for a new card.`, i);
      }
    }
    me.stats.popByRound[st.round - 1] = me.pop;

    st.active++;
    if (st.active >= st.cities.length) {
      st.active = 0; st.round++;
      st.roundEffect = null;
      if (st.round > st.cfg.rounds || (st.stopAfter && st.round > st.stopAfter)) { finish(st); return { ok: true, over: true }; }
    }
    startTurn(st);
    return { ok: true };
  }

  function startTurn(st) {
    if (st.active === 0 && st.eventPlan[st.round]) revealEvent(st, st.eventPlan[st.round]);
    const i = st.active, me = st.cities[i];
    const inc = income(st, i, 'collect');
    me.food = inc.food; me.trade = inc.trade;
    me.lastIncome = { food: inc.food, trade: inc.trade, lines: inc.lines, lostF: inc.lostF, lostT: inc.lostT };
    me.stats.own += inc.own; me.stats.routes += inc.routeF; me.stats.state += inc.stateF;
    const hits = [];
    if (inc.camels && inc.lostF + inc.lostT) hits.push('conquest');
    if (inc.shut && inc.lostF + inc.lostT) hits.push('canalCloses');
    if (inc.bandit && me.flags.bandits) hits.push('bandits');
    if (inc.bandit && st.roundEffect === 'banditsAll') hits.push('banditsAll');
    if (inc.crown) hits.push('crown');
    if (hits.length && (inc.lostT || inc.lostF)) me.stats.lost.push({ r: st.round, what: hits, food: inc.lostF, trade: inc.lostT });
    me.flags.bandits = false; me.flags.crown = false;
    draw(st, me);
    const lost = inc.lostT || inc.lostF ? ` (${[inc.lostF ? inc.lostF + ' Food' : '', inc.lostT ? inc.lostT + ' Trade' : ''].filter(Boolean).join(' and ')} lost to ${hits.map(h => ({ conquest: 'the conquest', canalCloses: 'the canal closure', bandits: 'bandits', banditsAll: 'bandits on the roads', crown: 'the Crown' }[h])).join(' and ')})` : '';
    log(st, 'collect', `${me.name} collected ${inc.food} Food and ${inc.trade} Trade${lost}.`, i);
  }

  function revealEvent(st, key) {
    const ev = EVENTS[key];
    st.lastEvent = { round: st.round, key };
    log(st, 'event', `${ev.name}. ${ev.text}`);
    if (ev.round) st.roundEffect = key;
    if (key === 'box') st.box = true;
    if (key === 'silts') st.silted = true;
    if (key === 'bourse') st.bourse = true;
    if (key === 'dynasty') {
      st.dynastyFallen = true;
      for (const c of st.cities) {
        const gone = c.tableau.filter(u => CARDS[cardType(st, u)].family === 'state');
        if (!gone.length) continue;
        c.tableau = c.tableau.filter(u => !gone.includes(u));
        const extra = Math.max(0, c.hinterlands - cap(st, c.i));
        c.hinterlands -= extra;
        c.stats.lost.push({ r: st.round, what: ['dynasty'], cards: gone.map(u => cardType(st, u)), hinterlands: extra });
        log(st, 'event', `${c.name} lost ${gone.map(u => CARDS[cardType(st, u)].name).join(', ')}${extra ? `, and ${extra} Hinterland${extra > 1 ? 's' : ''} that the canals had watered` : ''}.`, c.i);
      }
    }
  }

  // The page's clock: finish the round in progress, then end the game.
  function stopAfterThisRound(st) { if (!st.over) st.stopAfter = st.round; }

  function finish(st) {
    st.over = true; st.round = Math.min(st.round - 1, st.cfg.rounds);
    const best = Math.max(...st.cities.map(c => c.pop));
    const winners = st.cities.filter(c => c.pop === best).map(c => c.i);
    st.results = { winners, pops: st.cities.map(c => c.pop) };
    log(st, 'end', `Game over. ${winners.map(w => st.cities[w].name).join(' and ')} ${winners.length > 1 ? 'tie' : 'wins'} with Population ${best}.`);
  }

  // ------------------------------------------------------------------ bots --
  /* Two players for the simulation, and for filling an empty seat at a table.
   *  'greedy': plays whichever move most raises its projected final Population,
   *            less a quarter of the leading rival's. Knows the dynasty always
   *            falls (cfg.dynastyRounds) and prices State cards accordingly.
   *  'novice': plays any legal basic, then each affordable card with even odds,
   *            at a random target. A stand-in for a first-time player.        */
  function rng(st) { return next(st, 'botRng'); }

  // Growth a bot expects from an income. Growth takes both resources, so a
  // strict min() gives the non-binding one zero value and a bot never builds
  // toward balance; a surplus is worth a fifth as much, up to 3 units.
  const soft = (a, b) => Math.min(a, b) + 0.2 * Math.min(Math.abs(a - b), 3);
  function gCont(st, f, t, elev) {
    const c = st.cfg;
    let g = soft(f / c.foodPerPop, t / c.tradePerPop);
    if (elev && f >= c.elevatorIn) g = Math.max(g, soft((f - c.elevatorIn) / c.foodPerPop, (t + c.elevatorOut) / c.tradePerPop));
    return Math.max(0, g);
  }
  function pAlive(st, roundT) {
    if (st.dynastyFallen) return 0;
    if (!st.cfg.events.includes('dynasty')) return 1;
    // Not fallen yet during round r means it falls at the start of a later one.
    const cand = st.cfg.dynastyRounds.filter(d => d > st.round);
    if (!cand.length) return 1;
    return cand.filter(d => d > roundT).length / cand.length;
  }
  function projected(st, j, self) {
    const c = st.cities[j], R = st.cfg.rounds;
    const elev = tableauTypes(st, j).includes('elevator');
    let v = c.pop, firstFuture;
    if (self) {
      v += growthOf(st, c.food, c.trade) + (elev && !c.elevatorUsed ? 0.3 : 0);
      firstFuture = st.round + 1;
    } else firstFuture = j > st.active ? st.round : st.round + 1;
    const withS = income(st, j, 'steady', true), noS = income(st, j, 'steady', false);
    const gw = gCont(st, withS.food, withS.trade, elev), gn = gCont(st, noS.food, noS.trade, elev);
    for (let r = firstFuture; r <= R; r++) {
      const p = pAlive(st, r);
      v += p * gw + (1 - p) * gn;
    }
    if (!self && firstFuture <= R) {   // one-shot effects waiting on its next turn
      const nx = income(st, j, 'next', pAlive(st, firstFuture) > 0.5);
      v += gCont(st, nx.food, nx.trade, elev) - (pAlive(st, firstFuture) * gw + (1 - pAlive(st, firstFuture)) * gn);
    }
    return v;
  }
  function objective(st, i, lambda) {
    let best = -Infinity;
    for (const c of st.cities) if (c.i !== i) best = Math.max(best, projected(st, c.i, false));
    return projected(st, i, true) - lambda * best;
  }
  const clone = st => JSON.parse(JSON.stringify(st));

  function botMoves(st) {
    const me = st.cities[st.active], moves = [];
    for (const uid of me.hand) for (const t of targets(st, uid)) moves.push({ uid, t });
    return moves;
  }

  function botTurn(st, style, opts) {
    opts = opts || {};
    const lambda = opts.lambda === undefined ? 0.25 : opts.lambda;
    const quiet = st.quiet;
    if (style === 'novice') {
      const me = st.cities[st.active];
      const basics = botMoves(st).filter(m => CARDS[cardType(st, m.uid)].basic);
      if (basics.length) { const m = basics[Math.floor(rng(st) * basics.length)]; play(st, m.uid, m.t); }
      for (const uid of me.hand.slice()) {
        if (!me.hand.includes(uid) || CARDS[cardType(st, uid)].basic) continue;
        const ts = targets(st, uid);
        if (ts.length && rng(st) < 0.5) play(st, uid, ts[Math.floor(rng(st) * ts.length)]);
      }
    } else {
      for (let guard = 0; guard < 20; guard++) {
        st.quiet = true;
        const base = objective(st, st.active, lambda);
        let best = null, bestV = base + 1e-6, bestBasic = null, bestBasicV = -Infinity;
        for (const m of botMoves(st)) {
          const type = cardType(st, m.uid), basic = !!CARDS[type].basic;
          const s2 = clone(st); s2.quiet = true; play(s2, m.uid, m.t);
          let v = objective(s2, st.active, lambda);
          if (basic && type === 'route') v += 0.02;   // free: on a tie, a Route is a place for a Host later
          if (v > bestV) { bestV = v; best = m; }
          if (basic && v > bestBasicV) { bestBasicV = v; bestBasic = m; }
        }
        // A free basic that projects no gain is still worth playing.
        if (!best && bestBasic) best = bestBasic;
        if (style === 'casual' && rng(st) < (opts.eps === undefined ? 0.3 : opts.eps)) {
          const ms = botMoves(st);
          best = ms.length && rng(st) < 0.7 ? ms[Math.floor(rng(st) * ms.length)] : null;
        }
        st.quiet = quiet;
        if (!best) break;
        play(st, best.uid, best.t);
      }
    }
    return endTurn(st);
  }

  return {
    DEFAULTS, CITIES, CARDS, EVENTS, DEFAULT_TABLE, DEFAULT_BOTS,
    newGame, dynastyWindow, canPlay, targets, whyNot, play, useElevator, canElevate, endTurn, growthPreview,
    income, costOf, cardText, geoMode, hasHost, routesOf, tableauTypes, hasPaper, botTurn, stopAfterThisRound, cap,
  };
}));
