import { Character, CharacterLimits } from "./types";

export const defaultLimits: CharacterLimits = {
  maxCharacters: 40,
  minValue: 500,
  maxValue: 20000,
  maxPower: 100,
};

export const demoCharacters: Character[] = [
  ["Iron Man","Marvel",5000,92,98,"Legendary","Genius engineer in a powered suit — repulsors, flight, and battlefield tech control."],
  ["Captain America","Marvel",5000,88,96,"Legendary","Super-soldier strength with an unbreakable shield and peerless battlefield leadership."],
  ["Thor","Marvel",6000,95,97,"Legendary","God of Thunder — commands lightning and wields the enchanted hammer Mjolnir."],
  ["Hulk","Marvel",5500,96,94,"Epic","Near-limitless rage-fuelled strength that grows the angrier he gets."],
  ["Spider-Man","Marvel",4500,87,99,"Legendary","Wall-crawling agility, super reflexes, and a danger-sensing spider-sense."],
  ["Doctor Strange","Marvel",5000,91,95,"Epic","Master of the mystic arts — spells, portals, and time manipulation."],
  ["Batman","DC",5000,89,99,"Legendary","No powers, all prep — peak human detective with an arsenal of gadgets."],
  ["Superman","DC",6000,100,99,"Legendary","Flight, super strength, and heat vision fuelled by a yellow sun."],
  ["Wonder Woman","DC",5500,94,96,"Legendary","Amazonian warrior with god-given strength, the Lasso of Truth, and combat mastery."],
  ["The Flash","DC",4500,93,94,"Epic","Superhuman speed that lets him outrun time itself."],
  ["Joker","DC",4000,70,99,"Legendary","No powers, pure chaos — a criminal mastermind who thrives on unpredictability."],
  ["Darth Vader","Star Wars",6000,97,98,"Legendary","Dark side Force wielder with telekinesis, a lightsaber, and cybernetic resilience."],
  ["Yoda","Star Wars",5000,96,95,"Legendary","Ancient Jedi Master — unmatched Force wisdom and lightsaber skill despite his size."],
  ["Harry Potter","Wizarding World",4000,82,98,"Epic","Skilled young wizard protected by an ancient sacrifice and quick-thinking bravery."],
  ["Dumbledore","Wizarding World",5500,94,97,"Legendary","One of the most powerful wizards alive, master of wandwork and wisdom."],
  ["Goku","Anime",6000,100,99,"Legendary","Saiyan warrior who keeps transforming past every power ceiling — Kamehameha included."],
  ["Naruto","Anime",5000,91,98,"Legendary","Nine-Tails jinchuriki with limitless shadow clones and never-give-up resolve."],
  ["Luffy","Anime",4500,94,97,"Epic","Rubber body from the Gum-Gum fruit, powered up by Gear transformations."],
  ["Gojo","Anime",5500,98,99,"Legendary","Strongest jujutsu sorcerer — Limitless technique and Domain Expansion."],
  ["Loki","Marvel",4000,86,97,"Epic","God of Mischief — illusions, shape-shifting, and silver-tongued manipulation."]
].map(([name, universe, basePrice, power, popularity, rarity, abilityNote], i) => ({
  id:`c${i+1}`, name:String(name), universe:String(universe),
  basePrice:Number(basePrice), power:Number(power),
  popularity:Number(popularity), rarity:String(rarity),
  abilityNote:String(abilityNote),
}));
