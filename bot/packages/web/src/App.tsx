import { Routes, Route } from "react-router-dom";
import { Dashboard } from "./screens/Dashboard";
import { ClientList } from "./screens/ClientList";
import { AddClient } from "./screens/AddClient";
import { ClientDetail } from "./screens/ClientDetail";
import { ServerDetail } from "./screens/ServerDetail";
import { Settings } from "./screens/Settings";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/clients" element={<ClientList />} />
      <Route path="/add" element={<AddClient />} />
      <Route path="/client/:id" element={<ClientDetail />} />
      <Route path="/server/:id" element={<ServerDetail />} />
      <Route path="/settings" element={<Settings />} />
    </Routes>
  );
}
