import './ui/style.css';
import { GameApp } from './game/app';

const app = new GameApp(document.getElementById('app')!, document.getElementById('ui')!);
app.start();
// debug handle for tooling / console inspection
(window as unknown as { __drivesim: GameApp }).__drivesim = app;

document.getElementById('splash')?.remove();
