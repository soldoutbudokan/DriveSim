import './ui/style.css';
import { Engine } from './core/engine';
import { CityWorld } from './world/world';
import { TrafficManager } from './traffic/manager';

const app = document.getElementById('app')!;
const ui = document.getElementById('ui')!;

const engine = new Engine(app, ui);
const world = new CityWorld();
engine.setWorld(world);
engine.attachMinimap(world.net);
engine.attachTraffic(new TrafficManager(world));
engine.buildPlayer();
engine.start();
engine.hud.setObjective('Free roam — Queen St W', 'Drive the city · ? for all controls');

document.getElementById('splash')?.remove();
