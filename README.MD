## Remote NetMD
*Brings Wireless to NetMD Devices*

Remote NetMD lets you set up a NetMD server on, for example, a Raspberry Pi connected to a NetMD-capable deck. It's then possible to remotely control that deck with any device on the same network with the help of Web Minidisc Pro. The program will automatically detect it when a device disconnects and connects again, so it can be left running unattended.
To get it working, you need to:

1. [Define the correct udev rules](https://github.com/glaubitz/linux-minidisc/tree/master/netmd/etc) on the Pi, so that the node application can access your device.
2. Clone `https://github.com/asivery/remote-netmd-server`
3. Run a script to generate the HTTPS self-signed certificates: `bash createhttpskeys.sh`
4. Install the dependencies with `npm i`
5. Run `node index.js`
6. Visit the page hosted at `https://<your pi's IP address>:11396/`, and acknowledge the security risk
7. Add it in Web Minidisc Pro, by clicking the 'Add Custom Device' in the connect screen's dropdown. Then, after filling in the address and the name you want to see the server displayed as in Web Minidisc Pro, you can select your device from the connect screen's dropdown and connect to it.
