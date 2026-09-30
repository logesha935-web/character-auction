BUILT-IN CHARACTER PICTURES
---------------------------
Drop character images in this folder and they are bundled into the website at build time
(so they load every time, from the site itself, and can never disappear).

Name each file after the character's id OR its name in lowercase-with-dashes:
  c1.png            -> Iron Man      (ids c1..c20, in the order of src/data.ts)
  captain-america.jpg
  spider-man.webp

Accepted: png, jpg, jpeg, webp, gif, svg, avif.
A picture uploaded with the pencil icon (owner key) always overrides the bundled one.
After adding files run:  npm run build   (or restart  npm run dev)  and redeploy.
