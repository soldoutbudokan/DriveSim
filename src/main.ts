import './ui/style.css';
import { Engine } from './core/engine';
import { ProvingGround } from './world/proving';

const app = document.getElementById('app')!;
const ui = document.getElementById('ui')!;

const engine = new Engine(app, ui);
engine.setWorld(new ProvingGround());
engine.buildPlayer();
engine.start();
engine.hud.setObjective('Free drive — proving ground', 'W to drive · ? for all controls');

document.getElementById('splash')?.remove();
