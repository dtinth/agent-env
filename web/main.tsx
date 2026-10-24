/**
 * The web configurator: a stepper over generate.ts. Each step's form sits
 * beside a running summary of every answer, and the files get a step of their
 * own at the end. Every change re-renders the files; nothing leaves the page.
 */

import { render } from "preact";
import "./app/claw.css";
import "./app/layout.css";
import { App } from "./app/shell.tsx";

render(<App />, document.getElementById("app")!);
