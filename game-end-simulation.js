// Command-line Arguments
global.program = require('commander');
global.program
.option('--net [action]', "'create' - generate a new network. 'update' - use and modify existing network. 'use' - use, but don't modify network. 'none' - use hardcoded weights. ['none']", 'none')
.option('--algorithm [algorithm]', "Can be 'minimax', 'greedy', or 'random'. ['minimax']", "minimax")
.option('--depth [depth]', "Minimax bot searches to this depth from the current state. [2]", "2")
.option('--nolog', "Don't append to log files.")
.option('--onlyinfo', "Hide debug messages and speed up bot calculations")
.option('--usechildprocess', "Use child process to execute heavy calculations with parent process keeping the connection to showdown server.")
.parse(process.argv);

const fs = require('fs');
const { Dex, PcmBattle, Minimax, initLog4js, Util, TeamValidator, TeamImporter } = require('percymon');
const moment = require('moment');

// Setup Logging
initLog4js(global.program.nolog, global.program.onlyinfo);
const logger = require('log4js').getLogger("bot");

const weights = {
  "p1_hp": 1024,
  "p2_hp": -1024,
}

simulateToGameEnd(weights, 100, 1, 1);

function simulateToGameEnd(weights, oneOnOneRepetition, minimaxDepth, minimaxRepetiton = 1) {
  const targetPokemonDir = 'Target Pokemons';
  const teamPokemonDir = 'Team Pokemons';

  const customGameFormat = Dex.getFormat(`gen8customgame`, true);
  customGameFormat.ruleset = customGameFormat.ruleset.filter(rule => rule !== 'Team Preview');
  customGameFormat.forcedLevel = 50;
  const teamValidator = new TeamValidator(customGameFormat);

  const targetPokemons = loadPokemonSetsFromTexts(`./${targetPokemonDir}`);
  const teamPokemons = loadPokemonSetsFromTexts(`./${teamPokemonDir}`);
  validatePokemonSets(teamValidator, targetPokemons);
  validatePokemonSets(teamValidator, teamPokemons);

  logger.info(teamPokemons.length + ' team pokemons are loaded.');
  logger.info(targetPokemons.length + ' target pokemons are loaded.');

  const teamSelections = threeOfAllCombinations(teamPokemons).slice(0, 1);
  const targetSelections = threeOfAllCombinations(targetPokemons).slice(0, 1);

  logger.info("start evaluating game end win/lose...")
  const minimax = new Minimax(false, minimaxRepetiton, false, weights);
  const evalValueTable = [];
  for (let i = 0; i < teamSelections.length; i++) {
    const myTeam = teamSelections[i];  
    const evalRecord = [];
    for (let j = 0; j < targetSelections.length; j++) {
      const oppTeam = targetSelections[j];
      logger.info(`Simulate about ${teamPokemonStr(myTeam)} vs ${teamPokemonStr(oppTeam)}`);
      const repeatedOneOnOneValues = []; 
      for (let k = 0; k < oneOnOneRepetition; k++) {
        const p1 = { name: 'botPlayer', avatar: 1, team: myTeam };
        const p2 = { name: 'humanPlayer', avatar: 1, team: oppTeam };								
        const battleOptions = { format: customGameFormat, rated: false, send: null, p1, p2 };
        const battle = new PcmBattle(battleOptions);
        battle.start();              
        battle.makeRequest();                   

        const limitSteps = 20;
        let i = 0;
        for (i = 1; i <= limitSteps; i++) {
          console.log(`\nStep: ${i}, Turn: ${battle.turn}`);

          const { p1Choices } = Util.parseRequest(battle.p1.request);
          const minimaxDecision = minimax.decide(Util.cloneBattle(battle), p1Choices, minimaxDepth);

          if (battle.p1.request.wait) {
            const p2BestChoice = minimaxDecision.tree.action;
            battle.choose('p2', Util.toChoiceString(p2BestChoice, battle.p2), battle.rqid);
            console.log("Player action: (wait)");
            console.log("Opponent action: " + Util.toChoiceString(p2BestChoice, battle.p2));            
          } else if (battle.p2.request.wait) {
            const p1BestChoice = minimaxDecision.tree.action;             
            battle.choose('p1', Util.toChoiceString(p1BestChoice, battle.p1), battle.rqid);
            console.log("Player action: " + Util.toChoiceString(p1BestChoice, battle.p1));
            console.log("Opponent action: (wait)");            
          } else {
            const p1BestChoice = minimaxDecision.tree.action;

            if (minimaxDecision.tree.type !== 'max') {
              throw new Error('Child tree of root is not maximum tree. this is likely caused because this turn p1 has a wait request')                
            }
            const p1BestChoiceTree = minimaxDecision.tree.children.find(x => x.value === minimaxDecision.tree.value);
            if (p1BestChoiceTree.type !== 'min') {
              throw new Error('Child tree of p1 best choice is not minimum tree. this is likely caused because this turn p2 has a wait request')                
            }
            const p2BestChoice = p1BestChoiceTree.action;
            
            battle.choose('p1', Util.toChoiceString(p1BestChoice, battle.p1), battle.rqid);
            battle.choose('p2', Util.toChoiceString(p2BestChoice, battle.p2), battle.rqid);
            console.log("Player action: " + Util.toChoiceString(p1BestChoice, battle.p1));
            console.log("Opponent action: " + Util.toChoiceString(p2BestChoice, battle.p2));            
          }

          showBothSideHp(battle);
          if (battle.ended) {
            console.log(`battle ended!`);
            console.log(`winner: ${battle.winner}`)
            console.log()
            repeatedOneOnOneValues.push({ myTeam: p1.team, steps: i, winner: battle.winner});
            break;  
          } else if (i === limitSteps) {
            throw new Error(`battle did not finished within ${limitSteps} steps`);
          } else {
            continue;
          }
        }     
      } // end loop of oneononerepetition
      let stepSum = 0.0;
      repeatedOneOnOneValues.forEach(x => stepSum += x.steps);

      console.log(`botPlayerWins: ${repeatedOneOnOneValues.filter(x => x.winner === 'botPlayer').length}`)
      console.log(`humanPlayerWins: ${repeatedOneOnOneValues.filter(x => x.winner === 'humanPlayer').length}`)
      console.log(`average steps: ${stepSum / repeatedOneOnOneValues.length}`)
    };
  }

	console.log("calculation finished");
}

function teamPokemonStr(team) {
  return `[${team.map(x => x.species).join(', ')}]`;
}

function showBothSideHp(battle)  {
  // console.log("Current status of both sides:");
  let logP1 = '';
  for(let k = 0; k < battle.p1.pokemon.length; k++) {
      logP1 += (battle.p1.pokemon[k].species.name + ": " + battle.p1.pokemon[k].hp + "/" + battle.p1.pokemon[k].maxhp) + ', ';
  }
  console.log(`p1: ${logP1}`)
  let logP2 = '';
  for(let k = 0; k < battle.p2.pokemon.length; k++) {
      logP2 += (battle.p2.pokemon[k].species.name + ": " + battle.p2.pokemon[k].hp + "/" + battle.p2.pokemon[k].maxhp) + ', ';
  }
  console.log(`p2: ${logP2}`)
}

function threeOfAllCombinations(pokemons) {
  const combinations = [];
  for (let i = 0; i < pokemons.length; i++) {
    for (let j = i + 1; j < pokemons.length; j++) {
      for (let k = j + 1; k < pokemons.length; k++) {
        combinations.push([pokemons[i], pokemons[j], pokemons[k]]);
      }
    }
  }

  return combinations;
}

// Read target pokemon sets from team text. If an error occurs, just skip the file and continue.
function loadPokemonSetsFromTexts(directoryPath) {
  const filenames = fs.readdirSync(directoryPath);
  const pokemons = [];

  filenames.forEach(filename => {
    try {
      const rawText = fs.readFileSync(`${directoryPath}/${filename}`, "utf8");
      const pokemonSets = TeamImporter.importTeam(rawText); 
      if (!pokemonSets) {
        logger.warn(`'${filename}' doesn't contain a valid pokemon expression. We will just ignore this file.`);
      } else if (pokemonSets.length > 1) {
        logger.warn(`'${filename}' seems to have more than one pokemon expression. Subsequent ones are ignored.`);
      }
      pokemons.push(pokemonSets[0]);
    } catch (error) {
      logger.warn(`Failed to import '${filename}'. Is this a text of a target pokemon?`);
      logger.warn(error);
    }
  });

  return pokemons;
}

// Validate pokemon sets. If the validation failed about one of target pokemons, throw an exception.
function validatePokemonSets(teamValidator, pokemonSets) {
  pokemonSets.forEach(pokemonSet => {
    const setValidationProblems = teamValidator.validateSet(pokemonSet);
    if (setValidationProblems) {
      logger.error(`${setValidationProblems.length} problem(s) is found about ${pokemonSet.species} during the validation.`);
      setValidationProblems.forEach(problem => {
        logger.error(problem);
      })
      throw new Error('Pokemon Set Validation Error');
    }  
  })
}

