# ⏱️ Temps d'écran

Application web pour gérer le temps d'écran de tes enfants, synchronisée en temps réel entre tous les appareils via Supabase.

## 1. Créer les tables Supabase

1. Va sur [supabase.com](https://supabase.com) → ton projet → **SQL Editor** → **New query**.
2. Colle tout le contenu de [`schema.sql`](schema.sql) et clique **Run**.
3. Vérifie dans **Table Editor** que les tables `children` et `adjustments` sont bien créées.

Les clés dans [`config.js`](config.js) sont déjà pré-remplies avec ton URL et ta clé `anon` (publique par nature — ne mets jamais la clé `service_role` dans ce fichier).

## 2. Tester en local

Ouvre simplement `index.html` dans un navigateur (double-clic), ou sers le dossier avec un petit serveur local :

```bash
python -m http.server 8080
```

puis ouvre `http://localhost:8080`.

## 3. Déployer sur GitHub Pages

```bash
git init
git add .
git commit -m "Temps d'écran - version initiale"
gh repo create temps-ecran --public --source=. --push
```

Puis sur GitHub : **Settings → Pages → Source : branche `main`, dossier `/ (root)`**. La page sera accessible à une URL du type `https://<ton-user>.github.io/temps-ecran/`, utilisable depuis n'importe quel appareil (téléphone, tablette, ordinateur).

## Fonctionnement

- **Démarrer/Pause** : enregistre un timestamp `started_at` en base. Le décompte est recalculé à partir de ce timestamp, donc il survit à un rafraîchissement de page ou à la fermeture de l'onglet.
- **Synchronisation** : Supabase Realtime pousse les changements instantanément vers tous les appareils ouverts.
- **Réglages ⚙️** : temps autorisé par jour de la semaine (lundi à dimanche), couleur et avatar de l'enfant. Permet aussi de supprimer l'enfant.
- **➕➖** : ajout/retrait ponctuel de temps (boutons rapides +10/+30/-10/-30 min, ou saisie libre + raison). Chaque ajustement est journalisé dans la table `adjustments`.
- **Reset quotidien** : automatique à minuit (heure locale de l'appareil qui a l'app ouverte) — le temps consommé et les bonus du jour sont remis à zéro, la limite hebdomadaire reprend pour le nouveau jour.
- **Alarme** : bip sonore + halo rouge clignotant quand le temps est écoulé, sur chaque appareil qui a la page ouverte.

## Sécurité

Cette application n'a pas de compte utilisateur : quiconque a le lien peut voir/modifier les données (accès ouvert via la clé `anon`). C'est adapté à un usage familial privé (lien non partagé publiquement), mais n'y stocke aucune donnée sensible. Si tu veux restreindre l'accès plus tard, on peut ajouter un code PIN simple ou une authentification Supabase.
