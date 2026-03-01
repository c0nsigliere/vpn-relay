import { Routes, Route } from "react-router-dom";
import { ClientList } from "./screens/ClientList";
import { AddClient } from "./screens/AddClient";
import { ClientDetail } from "./screens/ClientDetail";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<ClientList />} />
      <Route path="/add" element={<AddClient />} />
      <Route path="/client/:id" element={<ClientDetail />} />
    </Routes>
  );
}
