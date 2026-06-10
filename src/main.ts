import './ui/style.css';
import { GameApp } from './game/app';

const app = new GameApp(document.getElementById('app')!, document.getElementById('ui')!);
app.start();

document.getElementById('splash')?.remove();
