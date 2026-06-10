import './ui/style.css';
import { Engine } from './core/engine';
import { CityWorld } from './world/world';

const app = document.getElementById('app')!;
const ui = document.getElementById('ui')!;

const engine = new Engine(app, ui);
const world = new CityWorld();
engine.setWorld(world);
engine.attachMinimap(world.net);
engine.buildPlayer();
engine.start();
engine.hud.setObjective('Free roam — Queen St W', 'Drive the city · ? for all controls');

document.getElementById('splash')?.remove();
